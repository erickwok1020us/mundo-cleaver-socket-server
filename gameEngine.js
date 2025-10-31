/**
 * Server-Authoritative Game Engine
 * Phase 1: Health Authority
 * Phase 2: Projectile Authority
 * Phase 3: Movement Authority
 * 
 * This module manages the authoritative game state on the server.
 * Server manages health, knife spawning, trajectories, collisions, and player movement.
 */

const { monitorEventLoopDelay, eventLoopUtilization } = require('perf_hooks');

/**
 * Global event loop monitoring (singleton)
 * Monitors p50/p95/p99 delay and ELU across all rooms
 */
function ensureEventLoopMonitors() {
    if (!global.__EL_MON__) {
        const h = monitorEventLoopDelay({ resolution: 20 });
        h.enable();
        let eluPrev = eventLoopUtilization();
        const latest = { p50: 0, p95: 0, p99: 0, elu: 0 };
        const timer = setInterval(() => {
            const p50 = typeof h.percentile === 'function' ? h.percentile(50) / 1e6 : h.mean / 1e6;
            const p95 = typeof h.percentile === 'function' ? h.percentile(95) / 1e6 : Math.max(h.mean / 1e6, h.max / 1e6);
            const p99 = typeof h.percentile === 'function' ? h.percentile(99) / 1e6 : Math.max(h.mean / 1e6, h.max / 1e6);
            const eluNow = eventLoopUtilization(eluPrev);
            eluPrev = eluNow;
            latest.p50 = p50;
            latest.p95 = p95;
            latest.p99 = p99;
            latest.elu = eluNow.utilization;
            h.reset();
        }, 5000);
        global.__EL_MON__ = { h, latest, timer };
        console.log('[GAME-ENGINE] Event loop monitoring initialized');
    }
    return global.__EL_MON__;
}

class GameEngine {
    constructor(roomCode, gameMode) {
        this.roomCode = roomCode;
        this.gameMode = gameMode;
        this.maxPlayers = gameMode === '1v1' ? 2 : 6;
        
        this.players = new Map();
        this.knives = new Map();
        this.gameStarted = false;
        this.serverTick = 0;
        this.nextKnifeId = 1;
        
        this.COLLISION_RADIUS = 7.35;
        this.MAX_HEALTH = 5;
        this.KNIFE_SPEED = 4.5864;
        this.KNIFE_COOLDOWN = 2200;
        this.KNIFE_LIFETIME = 5000;
        this.PLAYER_SPEED = 23.4;
        this.MAP_BOUNDS = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
        
        ensureEventLoopMonitors();
        
        this.TICK_RATE = 125;
        this.NETWORK_UPDATE_RATE = 60;
        
        this.tickIntervalNs = BigInt(Math.floor(1_000_000_000 / this.TICK_RATE));
        this.netIntervalNs = BigInt(Math.floor(1_000_000_000 / this.NETWORK_UPDATE_RATE));
        this.nextTickNs = 0n;
        this.nextNetNs = 0n;
        
        this.netCurrentRate = 60;
        this.degradeState = 'normal';
        this.overloadConsec = 0;
        this.recoverConsec = 0;
        
        this.tickCount = 0;
        this.broadcastCount = 0;
        this.catchUpTicks = 0;
        this.catchUpClamps = 0;
        this.lastStatsLog = Date.now();
        
        this.wStats = {
            moveNs: 0n,
            knivesNs: 0n,
            collisionsNs: 0n,
            broadcastNs: 0n,
            collisionTests: 0,
            bytesSent: 0,
            broadcastSampleCtr: 0,
            players: 0,
            knives: 0,
            tickCount: 0,
            broadcastCount: 0,
            catchUpTicks: 0,
            clamps: 0
        };
        
        this.loopRunning = false;
        this.gameLoopInterval = null;
        
        console.log(`[GAME-ENGINE] Room ${roomCode} initialized - Mode: ${gameMode}, Tick Rate: ${this.TICK_RATE} Hz, Network Rate: ${this.NETWORK_UPDATE_RATE} Hz`);
    }
    
    /**
     * Add a player to the game
     */
    addPlayer(socketId, playerId, team) {
        const normalizedTeam = Number(team);
        this.players.set(socketId, {
            socketId,
            playerId,
            team: normalizedTeam,
            health: this.MAX_HEALTH,
            x: 0,
            z: 0,
            targetX: 0,
            targetZ: 0,
            isMoving: false,
            isDead: false,
            lastKnifeTime: 0
        });
        
        console.log(`[GAME-ENGINE] Player ${playerId} (Team ${normalizedTeam}, type=${typeof normalizedTeam}) added to room ${this.roomCode}`);
        console.log(`[GAME-ENGINE] Room ${this.roomCode} now has ${this.players.size} players`);
    }
    
    /**
     * Remove a player from the game
     */
    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            console.log(`[GAME-ENGINE] Player ${player.playerId} removed from room ${this.roomCode}`);
            this.players.delete(socketId);
        }
    }
    
    /**
     * Update a player's team assignment
     */
    updatePlayerTeam(socketId, newTeam) {
        const player = this.players.get(socketId);
        if (player) {
            const normalizedTeam = Number(newTeam);
            player.team = normalizedTeam;
            console.log(`[GAME-ENGINE] Player ${player.playerId} team updated to ${normalizedTeam} (type=${typeof normalizedTeam}) in room ${this.roomCode}`);
        }
    }
    
    /**
     * Initialize spawn positions for all players based on their teams
     */
    initializeSpawnPositions() {
        const team1Spawn = { x: -30, z: 0 };
        const team2Spawn = { x: 30, z: 0 };
        
        for (const [socketId, player] of this.players.entries()) {
            const team = Number(player.team);
            
            if (team === 1) {
                player.x = team1Spawn.x;
                player.z = team1Spawn.z;
            } else if (team === 2) {
                player.x = team2Spawn.x;
                player.z = team2Spawn.z;
            } else {
                console.log(`[GAME-ENGINE] WARNING: Player has invalid team ${player.team} (type: ${typeof player.team}), defaulting to (0, 0)`);
            }
            
            player.targetX = player.x;
            player.targetZ = player.z;
            
            console.log(`[GAME-ENGINE] Initialized spawn for Team ${player.team} (type: ${typeof player.team}) at (${player.x}, ${player.z})`);
        }
    }
    
    /**
     * Start the game loop - uses precise hrtime-based loop for 1v1, setInterval for others
     */
    startGameLoop(io) {
        if (this.loopRunning || this.gameLoopInterval) {
            console.log(`[GAME-ENGINE] Game loop already running for room ${this.roomCode}`);
            return;
        }
        
        this.initializeSpawnPositions();
        this.broadcastGameState(io);
        this.gameStarted = true;
        
        const now = process.hrtime.bigint();
        this.nextTickNs = now;
        this.nextNetNs = now;
        this.loopRunning = true;
        console.log(`[GAME-ENGINE] Starting HIGH-PERFORMANCE game loop for room ${this.roomCode} (${this.gameMode}) - Physics: ${this.TICK_RATE} Hz, Network: ${this.NETWORK_UPDATE_RATE} Hz`);
        this.runPreciseLoop(io);
    }
    
    /**
     * Stop the game loop
     */
    stopGameLoop() {
        this.loopRunning = false;
        if (this.gameLoopInterval) {
            clearInterval(this.gameLoopInterval);
            this.gameLoopInterval = null;
        }
        this.gameStarted = false;
        console.log(`[GAME-ENGINE] Game loop stopped for room ${this.roomCode}`);
    }
    
    /**
     * Precise game loop for high-performance mode (1v1)
     * Uses hrtime for nanosecond precision, separate schedulers for physics and network
     */
    runPreciseLoop(io) {
        if (!this.loopRunning) return;
        
        const now = process.hrtime.bigint();
        const maxCatchUpTicks = 8;
        
        let tickLoops = 0;
        while (now >= this.nextTickNs && tickLoops < maxCatchUpTicks) {
            const fixedDt = 1 / this.TICK_RATE;
            this.serverTick++;
            this.wStats.tickCount++;
            
            const t0 = process.hrtime.bigint();
            this.updatePlayerMovement(fixedDt);
            const t1 = process.hrtime.bigint();
            this.updateKnives(fixedDt, io);
            const t2 = process.hrtime.bigint();
            this.checkKnifeCollisions(io);
            const t3 = process.hrtime.bigint();
            this.checkGameOver(io);
            
            this.wStats.moveNs += (t1 - t0);
            this.wStats.knivesNs += (t2 - t1);
            this.wStats.collisionsNs += (t3 - t2);
            
            this.wStats.players = this.players.size;
            this.wStats.knives = this.knives.size;
            
            this.nextTickNs += this.tickIntervalNs;
            tickLoops++;
        }
        
        if (tickLoops > 0) {
            this.catchUpTicks += tickLoops;
            this.wStats.catchUpTicks += tickLoops;
        }
        
        if (now >= this.nextTickNs && tickLoops >= maxCatchUpTicks) {
            this.nextTickNs = now + this.tickIntervalNs;
            this.catchUpClamps++;
            this.wStats.clamps++;
        }
        
        let netLoops = 0;
        while (now >= this.nextNetNs) {
            const b0 = process.hrtime.bigint();
            this.broadcastGameState(io);
            const b1 = process.hrtime.bigint();
            this.wStats.broadcastNs += (b1 - b0);
            this.wStats.broadcastCount++;
            
            if (++this.wStats.broadcastSampleCtr >= 10) {
                const snapshot = this.getSnapshot();
                const payloadStr = JSON.stringify(snapshot);
                this.wStats.bytesSent += Buffer.byteLength(payloadStr);
                this.wStats.broadcastSampleCtr = 0;
            }
            
            this.broadcastCount++;
            this.nextNetNs += this.netIntervalNs;
            netLoops++;
        }
        
        const nowMs = Date.now();
        if (nowMs - this.lastStatsLog >= 5000) {
            const denom = 5;
            const ticksPerSec = this.wStats.tickCount / denom;
            const broadcastsPerSec = this.wStats.broadcastCount / denom;
            const avgCatchUp = this.wStats.catchUpTicks / Math.max(1, this.wStats.tickCount);
            
            const moveUs = Number(this.wStats.moveNs / BigInt(Math.max(1, this.wStats.tickCount))) / 1000;
            const knivesUs = Number(this.wStats.knivesNs / BigInt(Math.max(1, this.wStats.tickCount))) / 1000;
            const collUs = Number(this.wStats.collisionsNs / BigInt(Math.max(1, this.wStats.tickCount))) / 1000;
            const bcastUs = Number(this.wStats.broadcastNs / BigInt(Math.max(1, this.wStats.broadcastCount))) / 1000;
            const testsPerSec = Math.round(this.wStats.collisionTests / denom);
            const approxBytesPerSec = Math.round((this.wStats.bytesSent * 10) / denom);
            
            const el = global.__EL_MON__.latest;
            
            const overloadNow = (el.p95 > 8) || (el.elu > 0.90);
            const recoverNow = (el.p95 < 6) && (el.elu < 0.70);
            
            if (overloadNow) {
                this.overloadConsec++;
                this.recoverConsec = 0;
                if (this.degradeState === 'normal' && this.overloadConsec >= 3) {
                    this.degradeState = 'degraded';
                    if (this.netCurrentRate !== 30) {
                        this.netCurrentRate = 30;
                        this.NETWORK_UPDATE_RATE = 30;
                        this.netIntervalNs = BigInt(1e9 / 30);
                        this.nextNetNs = process.hrtime.bigint() + this.netIntervalNs;
                        console.log(`[GAME-ENGINE] Room ${this.roomCode} AUTO-DEGRADE: network -> 30 Hz (EL p95=${el.p95.toFixed(2)}ms, ELU=${(el.elu*100).toFixed(1)}%)`);
                    }
                }
            } else if (recoverNow) {
                this.recoverConsec++;
                this.overloadConsec = 0;
                if (this.degradeState === 'degraded' && this.recoverConsec >= 5) {
                    this.degradeState = 'normal';
                    if (this.netCurrentRate !== 60) {
                        this.netCurrentRate = 60;
                        this.NETWORK_UPDATE_RATE = 60;
                        this.netIntervalNs = BigInt(1e9 / 60);
                        this.nextNetNs = process.hrtime.bigint() + this.netIntervalNs;
                        console.log(`[GAME-ENGINE] Room ${this.roomCode} RECOVER: network -> 60 Hz (EL p95=${el.p95.toFixed(2)}ms, ELU=${(el.elu*100).toFixed(1)}%)`);
                    }
                }
            } else {
                this.overloadConsec = 0;
                this.recoverConsec = 0;
            }
            
            console.log(
                `[GAME-ENGINE] Room ${this.roomCode} - ` +
                `Ticks/sec: ${ticksPerSec.toFixed(1)}, Broadcasts/sec: ${broadcastsPerSec.toFixed(1)}, ` +
                `AvgCatchUp: ${avgCatchUp.toFixed(2)}, Clamps: ${this.wStats.clamps} | ` +
                `EL p95: ${el.p95.toFixed(2)}ms, ELU: ${(el.elu*100).toFixed(1)}% | ` +
                `PhaseUs (move/knives/colls/bcast): ${moveUs.toFixed(2)}/${knivesUs.toFixed(2)}/${collUs.toFixed(2)}/${bcastUs.toFixed(2)} | ` +
                `P: ${this.wStats.players}, K: ${this.wStats.knives}, CollTests/sec: ${testsPerSec}, ` +
                `NetRate: ${this.NETWORK_UPDATE_RATE}Hz, NetBytes/sec: ~${approxBytesPerSec}`
            );
            
            this.wStats.moveNs = this.wStats.knivesNs = this.wStats.collisionsNs = this.wStats.broadcastNs = 0n;
            this.wStats.collisionTests = this.wStats.bytesSent = this.wStats.broadcastSampleCtr = 0;
            this.wStats.tickCount = this.wStats.broadcastCount = this.wStats.catchUpTicks = this.wStats.clamps = 0;
            
            this.tickCount = 0;
            this.broadcastCount = 0;
            this.catchUpTicks = 0;
            this.catchUpClamps = 0;
            this.lastStatsLog = nowMs;
        }
        
        const nextNs = this.nextTickNs < this.nextNetNs ? this.nextTickNs : this.nextNetNs;
        const remainingNs = nextNs - process.hrtime.bigint();
        
        if (remainingNs > 1_000_000n) {
            const delayMs = Number(remainingNs / 1_000_000n);
            setTimeout(() => setImmediate(() => this.runPreciseLoop(io)), delayMs);
        } else {
            setImmediate(() => this.runPreciseLoop(io));
        }
    }
    
    /**
     * Standard game tick for non-1v1 modes - runs at 60 Hz with accumulator for network
     */
    tickStandard(io) {
        const fixedDt = 1 / this.TICK_RATE;
        
        this.serverTick++;
        this.tickCount++;
        
        this.updatePlayerMovement(fixedDt);
        this.updateKnives(fixedDt, io);
        this.checkKnifeCollisions(io);
        
        const shouldBroadcast = (this.serverTick % Math.floor(this.TICK_RATE / this.NETWORK_UPDATE_RATE)) === 0;
        if (shouldBroadcast) {
            this.broadcastGameState(io);
            this.broadcastCount++;
        }
        
        const now = Date.now();
        if (now - this.lastStatsLog >= 5000) {
            console.log(`[GAME-ENGINE] Room ${this.roomCode} - Ticks/sec: ${this.tickCount / 5}, Broadcasts/sec: ${this.broadcastCount / 5}`);
            this.tickCount = 0;
            this.broadcastCount = 0;
            this.lastStatsLog = now;
        }
        
        this.checkGameOver(io);
    }
    
    /**
     * Handle knife throw request from client
     */
    handleKnifeThrow(socketId, targetX, targetZ, actionId, io) {
        const player = this.players.get(socketId);
        if (!player) {
            console.log(`[GAME-ENGINE] Invalid player socket: ${socketId}`);
            return null;
        }
        
        if (player.isDead) {
            console.log(`[GAME-ENGINE] Dead player cannot throw knife: ${player.playerId}`);
            return null;
        }
        
        const now = Date.now();
        if (now - player.lastKnifeTime < this.KNIFE_COOLDOWN) {
            console.log(`[GAME-ENGINE] Player ${player.playerId} knife on cooldown`);
            return null;
        }
        
        const knifeId = `${this.roomCode}-${this.nextKnifeId++}`;
        const directionX = targetX - player.x;
        const directionZ = targetZ - player.z;
        const length = Math.sqrt(directionX * directionX + directionZ * directionZ);
        
        if (length === 0) {
            console.log(`[GAME-ENGINE] Invalid knife direction for player ${player.playerId}`);
            return null;
        }
        
        const normalizedDirX = directionX / length;
        const normalizedDirZ = directionZ / length;
        
        const knife = {
            knifeId,
            ownerSocketId: socketId,
            ownerTeam: player.team,
            x: player.x,
            z: player.z,
            velocityX: normalizedDirX * this.KNIFE_SPEED,
            velocityZ: normalizedDirZ * this.KNIFE_SPEED,
            spawnTime: now,
            actionId,
            hasHit: false
        };
        
        this.knives.set(knifeId, knife);
        player.lastKnifeTime = now;
        
        console.log(`[GAME-ENGINE] 🔪 Team ${player.team} (type=${typeof player.team}) threw knife ${knifeId} towards (${targetX.toFixed(2)}, ${targetZ.toFixed(2)})`);
        
        io.to(this.roomCode).emit('serverKnifeSpawn', {
            knifeId,
            ownerTeam: Number(player.team),
            x: knife.x,
            z: knife.z,
            velocityX: knife.velocityX,
            velocityZ: knife.velocityZ,
            actionId,
            serverTick: this.serverTick,
            serverTime: now
        });
        
        return knife;
    }
    
    /**
     * Handle player movement request from client
     * Phase 3: Movement Authority
     */
    handlePlayerMove(socketId, targetX, targetZ, actionId) {
        const player = this.players.get(socketId);
        if (!player) {
            console.log(`[GAME-ENGINE] Invalid player socket for movement: ${socketId}`);
            return null;
        }
        
        if (player.isDead) {
            console.log(`[GAME-ENGINE] Dead player cannot move: ${player.playerId}`);
            return null;
        }
        
        const clampedX = Math.max(this.MAP_BOUNDS.minX, Math.min(this.MAP_BOUNDS.maxX, targetX));
        const clampedZ = Math.max(this.MAP_BOUNDS.minZ, Math.min(this.MAP_BOUNDS.maxZ, targetZ));
        
        player.targetX = clampedX;
        player.targetZ = clampedZ;
        player.isMoving = true;
        
        return {
            x: player.x,
            z: player.z,
            targetX: player.targetX,
            targetZ: player.targetZ,
            actionId
        };
    }
    
    /**
     * Update player positions based on their target positions
     * Phase 3: Movement Authority
     */
    updatePlayerMovement(dt) {
        for (const [socketId, player] of this.players.entries()) {
            if (!player.isMoving || player.isDead) continue;
            
            const dx = player.targetX - player.x;
            const dz = player.targetZ - player.z;
            const distance = Math.sqrt(dx * dx + dz * dz);
            
            if (distance < 0.1) {
                player.x = player.targetX;
                player.z = player.targetZ;
                player.isMoving = false;
                continue;
            }
            
            const moveDistance = this.PLAYER_SPEED * dt;
            
            if (distance <= moveDistance) {
                player.x = player.targetX;
                player.z = player.targetZ;
                player.isMoving = false;
            } else {
                const normalizedDx = dx / distance;
                const normalizedDz = dz / distance;
                
                player.x += normalizedDx * moveDistance;
                player.z += normalizedDz * moveDistance;
            }
        }
    }
    
    /**
     * Update all knives physics
     */
    updateKnives(dt, io) {
        const now = Date.now();
        const knivesToRemove = [];
        
        for (const [knifeId, knife] of this.knives.entries()) {
            if (knife.hasHit) {
                knivesToRemove.push(knifeId);
                continue;
            }
            
            if (now - knife.spawnTime > this.KNIFE_LIFETIME) {
                knivesToRemove.push(knifeId);
                continue;
            }
            
            knife.prevX = knife.x;
            knife.prevZ = knife.z;
            
            knife.x += knife.velocityX * dt;
            knife.z += knife.velocityZ * dt;
        }
        
        for (const knifeId of knivesToRemove) {
            this.knives.delete(knifeId);
            io.to(this.roomCode).emit('serverKnifeDestroy', {
                knifeId,
                serverTick: this.serverTick
            });
        }
    }
    
    /**
     * Check knife collisions with players using swept collision detection
     * This prevents tunneling when dt spikes or knife moves fast
     */
    checkKnifeCollisions(io) {
        for (const [knifeId, knife] of this.knives.entries()) {
            if (knife.hasHit) continue;
            
            let closestDistance = Infinity;
            let closestTeam = null;
            let enemyCandidates = 0;
            let totalPlayers = 0;
            let sameTeamSkips = 0;
            
            for (const [socketId, player] of this.players.entries()) {
                totalPlayers++;
                if (player.isDead) continue;
                if (player.team === knife.ownerTeam) {
                    sameTeamSkips++;
                    continue;
                }
                
                enemyCandidates++;
                this.wStats.collisionTests++;
                
                const prevX = knife.prevX !== undefined ? knife.prevX : knife.x;
                const prevZ = knife.prevZ !== undefined ? knife.prevZ : knife.z;
                
                const dx = player.x - knife.x;
                const dz = player.z - knife.z;
                const distance = Math.sqrt(dx * dx + dz * dz);
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestTeam = player.team;
                }
                
                const hit = this.lineCircleIntersection(
                    prevX, prevZ, knife.x, knife.z,
                    player.x, player.z, this.COLLISION_RADIUS
                );
                
                if (hit) {
                    knife.hasHit = true;
                    
                    const previousHealth = player.health;
                    player.health = Math.max(0, player.health - 1);
                    
                    console.log(`[GAME-ENGINE] 🎯 Knife ${knifeId} hit Team ${player.team} - Health: ${previousHealth} → ${player.health}`);
                    
                    if (player.health <= 0 && !player.isDead) {
                        player.isDead = true;
                        console.log(`[GAME-ENGINE] ☠️ Team ${player.team} Player ${player.playerId} died`);
                    }
                    
                    io.to(this.roomCode).emit('serverHealthUpdate', {
                        targetTeam: Number(player.team),
                        health: player.health,
                        isDead: player.isDead,
                        serverTick: this.serverTick,
                        serverTime: Date.now()
                    });
                    
                    io.to(this.roomCode).emit('serverKnifeHit', {
                        knifeId,
                        targetTeam: Number(player.team),
                        hitX: knife.x,
                        hitZ: knife.z,
                        serverTick: this.serverTick
                    });
                    
                    break;
                }
            }
            
            if (this.serverTick % 60 === 0) {
                const segmentLength = Math.sqrt(
                    Math.pow(knife.x - (knife.prevX || knife.x), 2) + 
                    Math.pow(knife.z - (knife.prevZ || knife.z), 2)
                );
                console.log(`[COLLISION-DEBUG] Knife ${knifeId} ownerTeam=${knife.ownerTeam}(${typeof knife.ownerTeam}), totalPlayers=${totalPlayers}, sameTeamSkips=${sameTeamSkips}, enemyCandidates=${enemyCandidates}, closestDist=${closestDistance.toFixed(2)}, radius=${this.COLLISION_RADIUS}, segLen=${segmentLength.toFixed(3)}`);
            }
        }
    }
    
    /**
     * Check if line segment intersects circle (swept collision detection)
     * Line from (x1,z1) to (x2,z2), circle at (cx,cz) with radius r
     */
    lineCircleIntersection(x1, z1, x2, z2, cx, cz, r) {
        const dx = cx - x1;
        const dz = cz - z1;
        
        const lx = x2 - x1;
        const lz = z2 - z1;
        
        const lineLength = Math.sqrt(lx * lx + lz * lz);
        if (lineLength < 0.001) {
            const dist = Math.sqrt(dx * dx + dz * dz);
            return dist < r;
        }
        
        const nx = lx / lineLength;
        const nz = lz / lineLength;
        
        const projection = dx * nx + dz * nz;
        
        const t = Math.max(0, Math.min(lineLength, projection));
        
        const closestX = x1 + nx * t;
        const closestZ = z1 + nz * t;
        
        const distX = cx - closestX;
        const distZ = cz - closestZ;
        const distance = Math.sqrt(distX * distX + distZ * distZ);
        
        return distance < r;
    }
    
    /**
     * Broadcast game state to all clients
     * Phase 3: Includes player positions
     */
    broadcastGameState(io) {
        const knivesArray = Array.from(this.knives.values())
            .filter(k => !k.hasHit)
            .map(k => ({
                knifeId: k.knifeId,
                ownerTeam: Number(k.ownerTeam),
                x: k.x,
                z: k.z,
                velocityX: k.velocityX,
                velocityZ: k.velocityZ
            }));
        
        const playersArray = Array.from(this.players.values()).map(p => ({
            team: Number(p.team),
            x: p.x,
            z: p.z,
            targetX: p.targetX,
            targetZ: p.targetZ,
            isMoving: p.isMoving,
            isDead: p.isDead
        }));
        
        io.to(this.roomCode).emit('serverGameState', {
            serverTick: this.serverTick,
            serverTime: Date.now(),
            knives: knivesArray,
            players: playersArray
        });
    }
    
    /**
     * Handle collision report from client
     * Server validates and applies damage
     */
    handleCollisionReport(attackerSocketId, targetTeam, io) {
        const attacker = this.players.get(attackerSocketId);
        if (!attacker) {
            console.log(`[GAME-ENGINE] Invalid attacker socket: ${attackerSocketId}`);
            return;
        }
        
        const targetTeamNum = Number(targetTeam);
        let target = null;
        for (const [socketId, player] of this.players.entries()) {
            if (Number(player.team) === targetTeamNum && !player.isDead) {
                target = player;
                break;
            }
        }
        
        if (!target) {
            console.log(`[GAME-ENGINE] No valid target found for team ${targetTeamNum}`);
            return;
        }
        
        if (Number(attacker.team) === Number(target.team)) {
            console.log(`[GAME-ENGINE] Invalid collision: same team attack`);
            return;
        }
        
        const previousHealth = target.health;
        target.health = Math.max(0, target.health - 1);
        
        console.log(`[GAME-ENGINE] ⚔️ Team ${attacker.team} hit Team ${target.team} - Health: ${previousHealth} → ${target.health}`);
        
        if (target.health <= 0 && !target.isDead) {
            target.isDead = true;
            console.log(`[GAME-ENGINE] ☠️ Team ${target.team} Player ${target.playerId} died`);
        }
        
        io.to(this.roomCode).emit('serverHealthUpdate', {
            targetTeam: Number(target.team),
            health: target.health,
            isDead: target.isDead,
            serverTick: this.serverTick,
            serverTime: Date.now()
        });
        
        return {
            targetTeam: Number(target.team),
            health: target.health,
            isDead: target.isDead
        };
    }
    
    /**
     * Check if game is over
     */
    checkGameOver(io) {
        if (!this.gameStarted) return;
        
        const teamAlive = new Map();
        for (const player of this.players.values()) {
            if (!player.isDead) {
                teamAlive.set(player.team, (teamAlive.get(player.team) || 0) + 1);
            }
        }
        
        const teams = Array.from(teamAlive.keys());
        if (teams.length === 1) {
            const winningTeam = teams[0];
            console.log(`[GAME-ENGINE] 🏆 Game Over! Team ${winningTeam} wins in room ${this.roomCode}`);
            
            io.to(this.roomCode).emit('serverGameOver', {
                winningTeam: Number(winningTeam),
                serverTick: this.serverTick,
                serverTime: Date.now()
            });
            
            this.stopGameLoop();
        }
    }
    
    /**
     * Get current game state snapshot
     */
    getSnapshot() {
        const playersArray = Array.from(this.players.values()).map(p => ({
            playerId: p.playerId,
            team: Number(p.team),
            health: p.health,
            isDead: p.isDead,
            x: p.x,
            z: p.z
        }));
        
        return {
            serverTick: this.serverTick,
            serverTime: Date.now(),
            players: playersArray
        };
    }
}

module.exports = GameEngine;
