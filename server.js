const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const GameEngine = require('./gameEngine');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
    res.send('Mundo Cleaver Socket Server is running');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: '*',
        methods: ["GET", "POST"]
    }
});

const rooms = {};
const gameEngines = {}; // roomCode -> GameEngine instance

io.on('connection', (socket) => {
    console.log(`[SOCKET] Client connected: ${socket.id}, transport: ${socket.conn.transport.name}`);
    
    socket.conn.on('upgrade', (transport) => {
        console.log(`[SOCKET] ${socket.id} upgraded to: ${transport.name}`);
    });
    
    socket.on('createRoom', (data) => {
        const { roomCode, gameMode } = data;
        
        if (!rooms[roomCode]) {
            const maxPlayers = gameMode === '1v1' ? 2 : 6;
            
            rooms[roomCode] = {
                hostSocket: socket.id,
                gameMode: gameMode,
                maxPlayers: maxPlayers,
                players: {
                    [socket.id]: {
                        playerId: 1,
                        team: 1, // Host is always Team 1 in 1v1, can change in 3v3
                        ready: false,
                        isHost: true,
                        loaded: false
                    }
                },
                playerCount: 1,
                gameStarted: false,
                teams: {
                    1: [socket.id], // Team 1 (LEFT)
                    2: []  // Team 2 (RIGHT)
                }
            };
            
            gameEngines[roomCode] = new GameEngine(roomCode, gameMode);
            gameEngines[roomCode].addPlayer(socket.id, 1, 1); // playerId: 1, team: 1
            
            socket.join(roomCode);
            socket.roomCode = roomCode;
            
            console.log(`Room created: ${roomCode} (${gameMode}, max ${maxPlayers} players) by ${socket.id}`);
            socket.emit('roomCreated', { roomCode, playerId: 1, team: 1 });
            
            io.to(roomCode).emit('roomState', {
                teams: rooms[roomCode].teams,
                players: rooms[roomCode].players,
                gameMode: gameMode,
                hostSocket: socket.id
            });
        }
    });
    
    socket.on('joinRoom', (data) => {
        const { roomCode } = data;
        
        if (!rooms[roomCode]) {
            socket.emit('joinError', { message: 'Room code does not exist' });
            return;
        }
        
        if (rooms[roomCode].playerCount >= rooms[roomCode].maxPlayers) {
            socket.emit('roomFull', { message: 'Room is full' });
            return;
        }
        
        const playerId = rooms[roomCode].playerCount + 1;
        const gameMode = rooms[roomCode].gameMode;
        let team;
        
        if (gameMode === '1v1') {
            team = 2;
            rooms[roomCode].teams[2].push(socket.id);
        } else {
            const team1Count = rooms[roomCode].teams[1].length;
            const team2Count = rooms[roomCode].teams[2].length;
            team = team1Count <= team2Count ? 1 : 2;
            rooms[roomCode].teams[team].push(socket.id);
        }
        
        rooms[roomCode].players[socket.id] = {
            playerId: playerId,
            team: team,
            ready: false,
            isHost: false,
            loaded: false
        };
        rooms[roomCode].playerCount++;
        
        if (gameEngines[roomCode]) {
            gameEngines[roomCode].addPlayer(socket.id, playerId, team);
        }
        
        socket.join(roomCode);
        socket.roomCode = roomCode;
        
        console.log(`Player ${socket.id} joined room ${roomCode} as Player ${playerId} (Team ${team})`);
        
        socket.emit('joinSuccess', { roomCode, playerId: playerId, team: team, gameMode: rooms[roomCode].gameMode });
        
        io.to(rooms[roomCode].hostSocket).emit('playerJoined', { roomCode, playerId: playerId, team: team });
        
        io.to(roomCode).emit('roomState', {
            teams: rooms[roomCode].teams,
            players: rooms[roomCode].players,
            gameMode: gameMode,
            hostSocket: rooms[roomCode].hostSocket
        });
    });
    
    socket.on('rejoinRoom', (data) => {
        const { roomCode, playerId } = data;
        
        console.log(`[REJOIN] Player attempting to rejoin - newSocketId:${socket.id} playerId:${playerId} roomCode:${roomCode}`);
        
        if (!rooms[roomCode]) {
            console.log(`[REJOIN] Room ${roomCode} not found`);
            socket.emit('joinError', { message: 'Room no longer exists' });
            return;
        }
        
        let oldSocketId = null;
        let playerData = null;
        
        for (const [socketId, player] of Object.entries(rooms[roomCode].players)) {
            if (player.playerId === playerId) {
                oldSocketId = socketId;
                playerData = player;
                break;
            }
        }
        
        if (!oldSocketId || !playerData) {
            console.log(`[REJOIN] Player ${playerId} not found in room ${roomCode}`);
            socket.emit('joinError', { message: 'Player not found in room' });
            return;
        }
        
        console.log(`[REJOIN] Found player ${playerId} with old socket ${oldSocketId}, updating to ${socket.id}`);
        
        delete rooms[roomCode].players[oldSocketId];
        rooms[roomCode].players[socket.id] = playerData;
        
        const team = playerData.team;
        const teamIndex = rooms[roomCode].teams[team].indexOf(oldSocketId);
        if (teamIndex > -1) {
            rooms[roomCode].teams[team][teamIndex] = socket.id;
        }
        
        if (rooms[roomCode].hostSocket === oldSocketId) {
            rooms[roomCode].hostSocket = socket.id;
            console.log(`[REJOIN] Updated hostSocket from ${oldSocketId} to ${socket.id}`);
        }
        
        if (gameEngines[roomCode]) {
            gameEngines[roomCode].updatePlayerSocket(oldSocketId, socket.id);
        }
        
        socket.join(roomCode);
        socket.roomCode = roomCode;
        
        console.log(`[REJOIN] Successfully rejoined player ${playerId} (Team ${team}) to room ${roomCode}`);
        
        socket.emit('rejoinSuccess', { 
            roomCode, 
            playerId: playerId, 
            team: team, 
            gameMode: rooms[roomCode].gameMode 
        });
        
        io.to(roomCode).emit('roomState', {
            teams: rooms[roomCode].teams,
            players: rooms[roomCode].players,
            gameMode: rooms[roomCode].gameMode,
            hostSocket: rooms[roomCode].hostSocket
        });
    });
    
    socket.on('playerReady', (data) => {
        const { roomCode, ready } = data;
        
        if (rooms[roomCode] && rooms[roomCode].players[socket.id]) {
            rooms[roomCode].players[socket.id].ready = ready;
            
            io.to(roomCode).emit('playerReadyUpdate', {
                playerId: rooms[roomCode].players[socket.id].playerId,
                ready: ready
            });
            
            console.log(`Player ${socket.id} ready state: ${ready} in room ${roomCode}`);
            
            io.to(roomCode).emit('roomState', {
                teams: rooms[roomCode].teams,
                players: rooms[roomCode].players,
                gameMode: rooms[roomCode].gameMode,
                hostSocket: rooms[roomCode].hostSocket
            });
        }
    });
    
    const handleTeamSelection = (data) => {
        const { roomCode, team } = data;
        
        console.log(`[TEAM-SELECT-SERVER] Player ${socket.id} requesting team ${team} in room ${roomCode}`);
        
        if (!rooms[roomCode] || !rooms[roomCode].players[socket.id]) {
            console.log(`[TEAM-SELECT-SERVER] Invalid room or player`);
            socket.emit('teamSelectError', { message: 'Invalid room or player' });
            return;
        }
        
        if (rooms[roomCode].players[socket.id].ready) {
            console.log(`[TEAM-SELECT-SERVER] Player is ready, cannot change teams`);
            socket.emit('teamSelectError', { message: 'Cannot change teams while ready' });
            return;
        }
        
        if (team !== 1 && team !== 2) {
            console.log(`[TEAM-SELECT-SERVER] Invalid team number: ${team}`);
            socket.emit('teamSelectError', { message: 'Invalid team number' });
            return;
        }
        
        const currentTeam = rooms[roomCode].players[socket.id].team;
        const inTeam1 = rooms[roomCode].teams[1].includes(socket.id);
        const inTeam2 = rooms[roomCode].teams[2].includes(socket.id);
        const inAnyTeam = inTeam1 || inTeam2;
        
        console.log(`[TEAM-SELECT-SERVER] Player status - currentTeam: ${currentTeam}, inTeam1: ${inTeam1}, inTeam2: ${inTeam2}, inAnyTeam: ${inAnyTeam}`);
        
        if (rooms[roomCode].gameMode === '1v1' && inAnyTeam && currentTeam !== team) {
            console.log(`[TEAM-SELECT-SERVER] Cannot switch teams in 1v1 mode`);
            socket.emit('teamSelectError', { message: 'Cannot change teams in 1v1 mode' });
            return;
        }
        
        if (currentTeam === team) {
            console.log(`[TEAM-SELECT-SERVER] Player already in team ${team}`);
            return;
        }
        
        const maxPerTeam = rooms[roomCode].gameMode === '1v1' ? 1 : 3;
        if (rooms[roomCode].teams[team].length >= maxPerTeam) {
            console.log(`[TEAM-SELECT-SERVER] Team ${team} is full (${rooms[roomCode].teams[team].length}/${maxPerTeam})`);
            socket.emit('teamSelectError', { message: 'Team is full' });
            return;
        }
        
        const currentTeamIndex = rooms[roomCode].teams[currentTeam].indexOf(socket.id);
        if (currentTeamIndex > -1) {
            rooms[roomCode].teams[currentTeam].splice(currentTeamIndex, 1);
            console.log(`[TEAM-SELECT-SERVER] Removed player from team ${currentTeam}`);
        }
        
        rooms[roomCode].teams[team].push(socket.id);
        rooms[roomCode].players[socket.id].team = team;
        
        if (gameEngines[roomCode]) {
            gameEngines[roomCode].updatePlayerTeam(socket.id, team);
        }
        
        console.log(`[TEAM-SELECT-SERVER] Player ${socket.id} switched to team ${team} in room ${roomCode}`);
        
        socket.emit('teamSelectSuccess', { team });
        
        io.to(roomCode).emit('roomState', {
            teams: rooms[roomCode].teams,
            players: rooms[roomCode].players,
            gameMode: rooms[roomCode].gameMode,
            hostSocket: rooms[roomCode].hostSocket
        });
    };
    
    socket.on('teamSelect', handleTeamSelection);
    socket.on('selectTeam', handleTeamSelection);
    
    socket.on('playerLoaded', (data) => {
        const { roomCode } = data;
        
        console.log(`Received playerLoaded from ${socket.id} for room ${roomCode}`);
        
        if (rooms[roomCode] && rooms[roomCode].players[socket.id]) {
            rooms[roomCode].players[socket.id].loaded = true;
            
            const playerLoadStatus = {};
            Object.entries(rooms[roomCode].players).forEach(([socketId, player]) => {
                playerLoadStatus[player.playerId] = player.loaded;
            });
            
            console.log(`Broadcasting playerLoadUpdate for room ${roomCode}:`, playerLoadStatus);
            io.to(roomCode).emit('playerLoadUpdate', playerLoadStatus);
            
            console.log(`Player ${socket.id} loaded in room ${roomCode}`);
            
            const allLoaded = Object.values(rooms[roomCode].players).every(p => p.loaded);
            console.log(`All players loaded check for room ${roomCode}: ${allLoaded}`);
            
            if (allLoaded) {
                console.log(`All players loaded in room ${roomCode}, emitting allPlayersLoaded`);
                io.to(roomCode).emit('allPlayersLoaded', { roomCode });
            }
        } else {
            console.log(`ERROR: Room ${roomCode} or player ${socket.id} not found`);
        }
    });
    
    socket.on('startGame', (data) => {
        const { roomCode } = data;
        
        if (!rooms[roomCode]) return;
        
        if (rooms[roomCode].hostSocket !== socket.id) {
            socket.emit('error', { message: 'Only host can start game' });
            return;
        }
        
        const allReady = Object.values(rooms[roomCode].players).every(p => p.ready);
        
        if (!allReady) {
            socket.emit('error', { message: 'All players must be ready' });
            return;
        }
        
        rooms[roomCode].gameStarted = true;
        
        Object.keys(rooms[roomCode].players).forEach(socketId => {
            rooms[roomCode].players[socketId].loaded = false;
        });
        
        io.to(roomCode).emit('gameStart', { roomCode });
        
        if (gameEngines[roomCode]) {
            gameEngines[roomCode].startGameLoop(io);
        }
        
        console.log(`Game started in room ${roomCode}`);
    });
    
    socket.on('playerMove', (data) => {
        const { roomCode, targetX, targetZ, actionId } = data;
        
        if (!gameEngines[roomCode]) {
            return;
        }
        
        gameEngines[roomCode].handlePlayerMove(socket.id, targetX, targetZ, actionId);
    });
    
    socket.on('knifeThrow', (data) => {
        const { roomCode, targetX, targetZ, actionId } = data;
        console.log(`[SERVER] Knife throw request - roomCode: ${roomCode}, target: (${targetX}, ${targetZ}), actionId: ${actionId}`);
        
        if (!gameEngines[roomCode]) {
            console.log(`[SERVER] No game engine found for room ${roomCode}`);
            return;
        }
        
        const knife = gameEngines[roomCode].handleKnifeThrow(socket.id, targetX, targetZ, actionId, io);
        
        if (knife) {
            console.log(`[SERVER] Knife spawned: ${knife.knifeId}`);
        }
    });
    
    socket.on('collisionReport', (data) => {
        const { roomCode, targetTeam, actionId } = data;
        console.log(`[SERVER] Collision report received - roomCode: ${roomCode}, targetTeam: ${targetTeam}, actionId: ${actionId}`);
        
        if (!gameEngines[roomCode]) {
            console.log(`[SERVER] No game engine found for room ${roomCode}`);
            return;
        }
        
        const result = gameEngines[roomCode].handleCollisionReport(socket.id, targetTeam, io);
        
        if (result) {
            console.log(`[SERVER] Collision validated - Team ${targetTeam} health: ${result.health}`);
        }
    });
    
    socket.on('healthUpdate', (data) => {
        const { roomCode, targetTeam, health } = data;
        console.log(`[SERVER] Legacy healthUpdate received - roomCode: ${roomCode}, targetTeam: ${targetTeam}, health: ${health}`);
        socket.to(roomCode).emit('opponentHealthUpdate', { targetTeam, health });
    });
    
    socket.on('disconnect', (reason) => {
        console.log(`[SOCKET] Client disconnected: ${socket.id}, reason: ${reason}`);
        
        if (socket.roomCode && rooms[socket.roomCode]) {
            const roomCode = socket.roomCode;
            const wasHost = rooms[roomCode].hostSocket === socket.id;
            
            console.log(`[DISCONNECT] Player ${socket.id} disconnected from room ${roomCode}, wasHost: ${wasHost}`);
            
            if (gameEngines[roomCode]) {
                gameEngines[roomCode].removePlayer(socket.id);
            }
            
            const playerTeam = rooms[roomCode].players[socket.id]?.team;
            if (playerTeam && rooms[roomCode].teams[playerTeam]) {
                const teamIndex = rooms[roomCode].teams[playerTeam].indexOf(socket.id);
                if (teamIndex > -1) {
                    rooms[roomCode].teams[playerTeam].splice(teamIndex, 1);
                }
            }
            
            delete rooms[roomCode].players[socket.id];
            rooms[roomCode].playerCount--;
            
            if (wasHost) {
                console.log(`[DISCONNECT] Host disconnected, closing room ${roomCode}`);
                io.to(roomCode).emit('hostDisconnected', { 
                    message: 'Host has left the room. Room is now closed.' 
                });
                
                if (gameEngines[roomCode]) {
                    gameEngines[roomCode].stopGameLoop();
                    delete gameEngines[roomCode];
                }
                delete rooms[roomCode];
                console.log(`Room ${roomCode} deleted (host disconnected)`);
            } else {
                socket.to(roomCode).emit('opponentDisconnected');
                
                if (rooms[roomCode].playerCount === 0) {
                    if (gameEngines[roomCode]) {
                        gameEngines[roomCode].stopGameLoop();
                        delete gameEngines[roomCode];
                    }
                    delete rooms[roomCode];
                    console.log(`Room ${roomCode} deleted (empty)`);
                } else {
                    io.to(roomCode).emit('roomState', {
                        teams: rooms[roomCode].teams,
                        players: rooms[roomCode].players,
                        gameMode: rooms[roomCode].gameMode,
                        hostSocket: rooms[roomCode].hostSocket
                    });
                }
            }
        }
    });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Socket.io server running on port ${PORT}`);
    console.log(`Health check available at http://0.0.0.0:${PORT}/health`);
});
