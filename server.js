const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const GameEngine = require('./gameEngine');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rooms = {};
const gameEngines = {}; // roomCode -> GameEngine instance

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
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
                        team: 1, // Host is always Team 1
                        ready: false,
                        isHost: true,
                        loaded: false
                    }
                },
                playerCount: 1,
                gameStarted: false
            };
            
            gameEngines[roomCode] = new GameEngine(roomCode, gameMode);
            gameEngines[roomCode].addPlayer(socket.id, 1, 1); // playerId: 1, team: 1
            
            socket.join(roomCode);
            socket.roomCode = roomCode;
            
            console.log(`Room created: ${roomCode} (${gameMode}, max ${maxPlayers} players) by ${socket.id}`);
            socket.emit('roomCreated', { roomCode, playerId: 1, team: 1 });
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
        const team = playerId === 2 ? 2 : Math.ceil(playerId / (rooms[roomCode].maxPlayers / 2));
        
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
        }
    });
    
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
        console.log(`[SERVER] Player move request - roomCode: ${roomCode}, target: (${targetX}, ${targetZ}), actionId: ${actionId}`);
        
        if (!gameEngines[roomCode]) {
            console.log(`[SERVER] No game engine found for room ${roomCode}`);
            return;
        }
        
        const moveResult = gameEngines[roomCode].handlePlayerMove(socket.id, targetX, targetZ, actionId);
        
        if (moveResult) {
            console.log(`[SERVER] Player move accepted for Team ${rooms[roomCode].players[socket.id]?.team}`);
        }
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
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        if (socket.roomCode && rooms[socket.roomCode]) {
            const roomCode = socket.roomCode;
            
            if (gameEngines[roomCode]) {
                gameEngines[roomCode].removePlayer(socket.id);
            }
            
            delete rooms[roomCode].players[socket.id];
            rooms[roomCode].playerCount--;
            
            socket.to(roomCode).emit('opponentDisconnected');
            
            if (rooms[roomCode].playerCount === 0) {
                if (gameEngines[roomCode]) {
                    gameEngines[roomCode].stopGameLoop();
                    delete gameEngines[roomCode];
                }
                delete rooms[roomCode];
                console.log(`Room ${roomCode} deleted (empty)`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Socket.io server running on port ${PORT}`);
});
