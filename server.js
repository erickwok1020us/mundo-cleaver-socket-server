const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

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
                        ready: false,
                        isHost: true
                    }
                },
                playerCount: 1,
                gameStarted: false
            };
            
            socket.join(roomCode);
            socket.roomCode = roomCode;
            
            console.log(`Room created: ${roomCode} (${gameMode}, max ${maxPlayers} players) by ${socket.id}`);
            socket.emit('roomCreated', { roomCode, playerId: 1 });
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
        
        rooms[roomCode].players[socket.id] = {
            playerId: playerId,
            ready: false,
            isHost: false
        };
        rooms[roomCode].playerCount++;
        
        socket.join(roomCode);
        socket.roomCode = roomCode;
        
        console.log(`Player ${socket.id} joined room ${roomCode} as Player ${playerId}`);
        
        socket.emit('joinSuccess', { roomCode, playerId: playerId, gameMode: rooms[roomCode].gameMode });
        
        io.to(rooms[roomCode].hostSocket).emit('playerJoined', { roomCode, playerId: playerId });
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
        
        io.to(roomCode).emit('gameStart', { roomCode });
        
        console.log(`Game started in room ${roomCode}`);
    });
    
    socket.on('playerMove', (data) => {
        const { roomCode, targetX, targetZ } = data;
        socket.to(roomCode).emit('opponentMove', { targetX, targetZ });
    });
    
    socket.on('knifeThrow', (data) => {
        const { roomCode, targetX, targetZ } = data;
        socket.to(roomCode).emit('opponentKnifeThrow', { targetX, targetZ });
    });
    
    socket.on('healthUpdate', (data) => {
        const { roomCode, playerId, health } = data;
        socket.to(roomCode).emit('opponentHealthUpdate', { playerId, health });
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        if (socket.roomCode && rooms[socket.roomCode]) {
            const roomCode = socket.roomCode;
            delete rooms[roomCode].players[socket.id];
            rooms[roomCode].playerCount--;
            
            socket.to(roomCode).emit('opponentDisconnected');
            
            if (rooms[roomCode].playerCount === 0) {
                delete rooms[roomCode];
                console.log(`Room ${roomCode} deleted (empty)`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Socket.io server running on port ${PORT}`);
});
