/**
 * Server-Authoritative Game Engine
 * Phase 1: Health Authority
 * Phase 2: Projectile Authority
 * Phase 3: Movement Authority
 * 
 * This module manages the authoritative game state on the server.
 * Server manages health, knife spawning, trajectories, collisions, and player movement.
 */

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
        
        this.PLAYER_SPEED = 2.5;
        this.MAP_BOUNDS = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
        
        this.TICK_RATE = 60;
        this.TICK_INTERVAL = 1000 / this.TICK_RATE;
        this.NETWORK_UPDATE_RATE = 20;
        this.networkUpdateCounter = 0;
        this.networkUpdateAccumulator = 0;
        
        this.lastUpdateTime = null;
        this.tickCount = 0;
        this.broadcastCount = 0;
        this.lastStatsLog = Date.now();
        
        this.gameLoopInterval = null;
    }
    
    /**
     * Add a player to the game
     */
    addPlayer(socketId, playerId, team) {
        this.players.set(socketId, {
            socketId,
            playerId,
            team,
            health: this.MAX_HEALTH,
            x: 0,
            z: 0,
            targetX: 0,
            targetZ: 0,
            isMoving: false,
            isDead: false,
            lastKnifeTime: 0
        });
        
        console.log(`[GAME-ENGINE] Player ${playerId} (Team ${team}) added to room ${this.roomCode}`);
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
            player.team = newTeam;
            console.log(`[GAME-ENGINE] Player ${player.playerId} team updated to ${newTeam} in room ${this.roomCode}`);
        }
    }
    
    /**
     * Start the game loop
     */
    startGameLoop(io) {
        if (this.gameLoopInterval) {
            console.log(`[GAME-ENGINE] Game loop already running for room ${this.roomCode}`);
            return;
        }
        
        this.gameStarted = true;
        this.lastUpdateTime = Date.now();
        console.log(`[GAME-ENGINE] Starting game loop for room ${this.roomCode} at ${this.TICK_RATE} Hz`);
        
        this.gameLoopInterval = setInterval(() => {
            this.tick(io);
        }, this.TICK_INTERVAL);
    }
    
    /**
     * Stop the game loop
     */
    stopGameLoop() {
        if (this.gameLoopInterval) {
            clearInterval(this.gameLoopInterval);
            this.gameLoopInterval = null;
            this.gameStarted = false;
            console.log(`[GAME-ENGINE] Game loop stopped for room ${this.roomCode}`);
        }
    }
    
    /**
     * Main game tick - runs at 60 Hz
     */
    tick(io) {
        const now = Date.now();
        const dt = this.lastUpdateTime ? Math.min((now - this.lastUpdateTime) / 1000, 0.1) : this.TICK_INTERVAL / 1000;
        this.lastUpdateTime = now;
        
        this.serverTick++;
        this.tickCount++;
        
        this.updatePlayerMovement(dt);
        this.updateKnives(dt, io);
        this.checkKnifeCollisions(io);
        
        this.networkUpdateAccumulator += dt;
        if (this.networkUpdateAccumulator >= (1 / this.NETWORK_UPDATE_RATE)) {
            this.broadcastGameState(io);
            this.broadcastCount++;
            this.networkUpdateAccumulator = 0;
        }
        
        if (now - this.lastStatsLog >= 1000) {
            console.log(`[GAME-ENGINE] Room ${this.roomCode} - Ticks/sec: ${this.tickCount}, Broadcasts/sec: ${this.broadcastCount}`);
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
        
        console.log(`[GAME-ENGINE] 🔪 Team ${player.team} threw knife ${knifeId} towards (${targetX.toFixed(2)}, ${targetZ.toFixed(2)})`);
        
        io.to(this.roomCode).emit('serverKnifeSpawn', {
            knifeId,
            ownerTeam: player.team,
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
        
        console.log(`[GAME-ENGINE] 🏃 Team ${player.team} moving to (${clampedX.toFixed(2)}, ${clampedZ.toFixed(2)})`);
        
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
     * Check knife collisions with players
     */
    checkKnifeCollisions(io) {
        for (const [knifeId, knife] of this.knives.entries()) {
            if (knife.hasHit) continue;
            
            for (const [socketId, player] of this.players.entries()) {
                if (player.isDead) continue;
                if (player.team === knife.ownerTeam) continue;
                
                const dx = knife.x - player.x;
                const dz = knife.z - player.z;
                const distance = Math.sqrt(dx * dx + dz * dz);
                
                if (distance < this.COLLISION_RADIUS) {
                    knife.hasHit = true;
                    
                    const previousHealth = player.health;
                    player.health = Math.max(0, player.health - 1);
                    
                    console.log(`[GAME-ENGINE] 🎯 Knife ${knifeId} hit Team ${player.team} - Health: ${previousHealth} → ${player.health}`);
                    
                    if (player.health <= 0 && !player.isDead) {
                        player.isDead = true;
                        console.log(`[GAME-ENGINE] ☠️ Team ${player.team} Player ${player.playerId} died`);
                    }
                    
                    io.to(this.roomCode).emit('serverHealthUpdate', {
                        targetTeam: player.team,
                        health: player.health,
                        isDead: player.isDead,
                        serverTick: this.serverTick,
                        serverTime: Date.now()
                    });
                    
                    io.to(this.roomCode).emit('serverKnifeHit', {
                        knifeId,
                        targetTeam: player.team,
                        hitX: knife.x,
                        hitZ: knife.z,
                        serverTick: this.serverTick
                    });
                    
                    break;
                }
            }
        }
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
                ownerTeam: k.ownerTeam,
                x: k.x,
                z: k.z,
                velocityX: k.velocityX,
                velocityZ: k.velocityZ
            }));
        
        const playersArray = Array.from(this.players.values()).map(p => ({
            team: p.team,
            x: p.x,
            z: p.z,
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
        
        let target = null;
        for (const [socketId, player] of this.players.entries()) {
            if (player.team === targetTeam && !player.isDead) {
                target = player;
                break;
            }
        }
        
        if (!target) {
            console.log(`[GAME-ENGINE] No valid target found for team ${targetTeam}`);
            return;
        }
        
        if (attacker.team === target.team) {
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
            targetTeam: target.team,
            health: target.health,
            isDead: target.isDead,
            serverTick: this.serverTick,
            serverTime: Date.now()
        });
        
        return {
            targetTeam: target.team,
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
                winningTeam,
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
            team: p.team,
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
