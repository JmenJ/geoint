const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 }); 

app.use(express.static('public'));

const rooms = {};

function generateRoomId() { return Math.random().toString(36).substring(2, 6).toUpperCase(); }

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function calculateBlitzPoints(distanceKm) {
    if (distanceKm === null) return 0;
    return Math.max(0, Math.round(5000 * Math.exp(-distanceKm / 1442))); 
}

function startRoomTimer(roomId, durationInSeconds, stage) {
    if (!rooms[roomId]) return;
    clearInterval(rooms[roomId].timerInterval);
    rooms[roomId].timeLeft = durationInSeconds;
    
    rooms[roomId].timerInterval = setInterval(() => {
        if (!rooms[roomId]) return clearInterval(rooms[roomId].timerInterval);
        rooms[roomId].timeLeft--;
        io.to(roomId).emit('timerTick', { stage: stage, time: rooms[roomId].timeLeft });

        if (rooms[roomId].timeLeft <= 0) {
            clearInterval(rooms[roomId].timerInterval);
            handleStageEnd(roomId, stage);
        }
    }, 1000);
}

function handleStageEnd(roomId, stage) {
    if (!rooms[roomId]) return;
    const room = rooms[roomId];
    
    if (stage === 'prep') {
        const submittedIds = room.puzzles.map(p => p.ownerId);
        for (let uid in room.players) {
            if (!submittedIds.includes(uid)) {
                const sId = room.players[uid].socketId;
                const s = io.sockets.sockets.get(sId);
                if (s) s.emit('kicked', 'Ты не загадал локацию и был исключен.');
                delete room.players[uid];
            }
        }

        if (Object.keys(room.players).length < 2) {
            io.to(roomId).emit('errorMsg', 'Игроков слишком мало. Возврат в лобби.');
            room.status = 'lobby'; room.puzzles = [];
            
            // Если хоста кикнуло, передаем права
            reassignHost(roomId);
            
            io.to(roomId).emit('updateLobby', Object.values(room.players));
            io.to(roomId).emit('roundEnded', 'Раунд отменен.');
        } else {
            startGamePhase(roomId);
        }
    } else if (stage === 'playing') {
        // abort if we dropped below two while playing
        if (Object.keys(room.players).length < 2) {
            io.to(roomId).emit('errorMsg', 'Игроков слишком мало. Игра завершена.');
            clearInterval(room.timerInterval);
            return showPodium(roomId);
        }

        if (room.gameMode === 'blitz') {
            for (let uid in room.players) {
                if (!room.players[uid].doneGuessing) processBlitzGuess(roomId, uid, room.players[uid].lastMarker);
            }
        } else {
            calculateOwnerScoresClassic(roomId);
        }
        finishRound(roomId);
    }
}

// НОВАЯ ФУНКЦИЯ: Передача хоста, если создатель вышел
function reassignHost(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const playerKeys = Object.keys(room.players);
    if (playerKeys.length > 0) {
        const hasHost = playerKeys.some(k => room.players[k].isHost);
        if (!hasHost) room.players[playerKeys[0]].isHost = true; // Отдаем коронку первому в списке
    }
}

function finishRound(roomId) {
    const room = rooms[roomId];

    // if someone left mid-round, just end
    if (Object.keys(room.players).length < 2) {
        io.to(roomId).emit('errorMsg', 'Игроков слишком мало. Игра завершена.');
        clearInterval(room.timerInterval);
        return showPodium(roomId);
    }

    if (room.gameMode === 'blitz') {
        // send current standings to all clients as interim result
        const sorted = Object.values(room.players).sort((a, b) => b.score - a.score);
        io.to(roomId).emit('blitzRoundResult', { currentRound: room.currentRound, maxRounds: room.maxRounds, players: sorted });
        io.to(roomId).emit('updateLobby', Object.values(room.players));

        if (room.currentRound < room.maxRounds) {
            // wait a few seconds so players can see interim results before next round
            setTimeout(() => {
                room.currentRound++;
                room.status = 'prep';
                room.puzzles = [];
                for (let uid in room.players) { room.players[uid].doneGuessing = false; room.players[uid].lastMarker = null; }
                io.to(roomId).emit('nextRoundPrep', { currentRound: room.currentRound, maxRounds: room.maxRounds });
                startRoomTimer(roomId, 300, 'prep');
            }, 5000);
        } else {
            // final round finished, show full podium after short delay
            setTimeout(() => showPodium(roomId), 5000);
        }
    } else {
        showPodium(roomId);
    }
}

function showPodium(roomId) {
    const room = rooms[roomId];
    room.status = 'podium'; room.votes = [];
    const sortedPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
    io.to(roomId).emit('showPodium', sortedPlayers);
}

function calculateOwnerScoresClassic(roomId) {
    const room = rooms[roomId];
    const totalPlayers = Object.keys(room.players).length;
    room.puzzles.forEach(puzzle => {
        const guessCount = puzzle.guessedBy.length;
        if (guessCount > 0 && guessCount < (totalPlayers - 1)) {
            if (room.players[puzzle.ownerId]) room.players[puzzle.ownerId].score += 1;
        }
    });
    io.to(roomId).emit('updateLobby', Object.values(room.players));
}

function checkEarlyFinishClassic(roomId) {
    const room = rooms[roomId];
    let allGuessed = true;
    for (let uid in room.players) {
        if (!room.players[uid].online) continue;
        room.puzzles.forEach(p => { if (p.ownerId !== uid && !p.guessedBy.includes(uid)) allGuessed = false; });
    }
    if (allGuessed) { clearInterval(room.timerInterval); handleStageEnd(roomId, 'playing'); }
}

function checkEarlyFinishBlitz(roomId) {
    const room = rooms[roomId];
    let allDone = true;
    for (let uid in room.players) {
        if (room.players[uid].online && !room.players[uid].doneGuessing) allDone = false;
    }
    if (allDone) { clearInterval(room.timerInterval); handleStageEnd(roomId, 'playing'); }
}

function startGamePhase(roomId) {
    const room = rooms[roomId];
    room.status = 'playing';
    
    if (room.gameMode === 'blitz') {
        const playerIds = Object.keys(room.players);
        const assigned = {};
        for(let i = 0; i < playerIds.length; i++) {
            assigned[playerIds[i]] = room.puzzles[(i + 1) % playerIds.length]; 
        }
        room.assignments = assigned;
        startRoomTimer(roomId, 90, 'playing'); 
        
        for (let uid in room.players) {
            const pzl = assigned[uid];
            const safePzl = { id: pzl.id, ownerName: pzl.ownerName, imgUrl: pzl.imgUrl };
            io.to(room.players[uid].socketId).emit('startGuessingPhaseBlitz', { puzzle: safePzl, currentRound: room.currentRound, maxRounds: room.maxRounds });
        }

    } else {
        startRoomTimer(roomId, 300, 'playing'); 
        // send each client list without their own puzzle
        for (let uid in room.players) {
            const filtered = room.puzzles
                .filter(p => p.ownerId !== uid)
                .map(p => ({ id: p.id, ownerId: p.ownerId, ownerName: p.ownerName, imgUrl: p.imgUrl, guessedBy: p.guessedBy }));
            io.to(room.players[uid].socketId).emit('startGuessingPhaseClassic', filtered);
        }
    }
}

function processBlitzGuess(roomId, userId, markerCoords) {
    const room = rooms[roomId];
    const player = room.players[userId];
    if (player.doneGuessing) return;

    player.doneGuessing = true;
    const targetPuzzle = room.assignments[userId];
    
    let distance = null; let points = 0;
    if (markerCoords && markerCoords.lat) {
        distance = getDistance(targetPuzzle.lat, targetPuzzle.lng, markerCoords.lat, markerCoords.lng);
        points = calculateBlitzPoints(distance);
        player.score += points;
    }

    io.to(player.socketId).emit('blitzResult', { points: points, distance: distance, targetLat: targetPuzzle.lat, targetLng: targetPuzzle.lng });
}

io.on('connection', (socket) => {
    
    socket.on('checkAutoReconnect', ({ userId, roomId }) => {
        if (rooms[roomId] && rooms[roomId].players[userId]) {
            socket.join(roomId); socket.roomId = roomId; socket.userId = userId;
            const room = rooms[roomId];
            room.players[userId].socketId = socket.id; room.players[userId].online = true;
            
            // send puzzles filtered for this user so they don't see their own
            const filtered = room.puzzles
                .filter(p => p.ownerId !== userId)
                .map(p => ({ id: p.id, ownerId: p.ownerId, ownerName: p.ownerName, imgUrl: p.imgUrl, guessedBy: p.guessedBy }));

            socket.emit('reconnectSuccess', { 
                roomId, gameMode: room.gameMode, players: Object.values(room.players), status: room.status, timeLeft: room.timeLeft,
                currentRound: room.currentRound, maxRounds: room.maxRounds,
                puzzles: filtered,
                assignedPuzzle: room.assignments ? room.assignments[userId] : null
            });
            io.to(roomId).emit('updateLobby', Object.values(room.players));
        } else {
            socket.emit('reconnectFailed');
        }
    });

    socket.on('createRoom', ({ playerName, userId, gameMode }) => {
        const roomId = generateRoomId();
        rooms[roomId] = { status: 'lobby', gameMode: gameMode, currentRound: 1, maxRounds: gameMode === 'blitz' ? 5 : 1, players: {}, puzzles: [], votes: [] };
        // ДОБАВЛЕНО id: userId и isHost: true
        rooms[roomId].players[userId] = { id: userId, socketId: socket.id, name: playerName, score: 0, online: true, cooldown: 0, lastMarker: null, doneGuessing: false, isHost: true };
        socket.join(roomId); socket.roomId = roomId; socket.userId = userId; 
        socket.emit('roomJoined', { roomId, gameMode, players: Object.values(rooms[roomId].players) });
    });

    socket.on('joinRoom', ({ roomId, playerName, userId }) => {
        if (!rooms[roomId]) return socket.emit('errorMsg', 'Комната не найдена!');
        const isReconnect = !!rooms[roomId].players[userId];
        if (rooms[roomId].status !== 'lobby' && !isReconnect) return socket.emit('errorMsg', 'Игра уже началась! Вход закрыт.');

        socket.join(roomId); socket.roomId = roomId; socket.userId = userId;

        if (!isReconnect) {
            const isFirst = Object.keys(rooms[roomId].players).length === 0;
            rooms[roomId].players[userId] = { id: userId, socketId: socket.id, name: playerName, score: 0, online: true, cooldown: 0, lastMarker: null, doneGuessing: false, isHost: isFirst };
        }
        else { rooms[roomId].players[userId].socketId = socket.id; rooms[roomId].players[userId].name = playerName; rooms[roomId].players[userId].online = true; }
        
        io.to(roomId).emit('updateLobby', Object.values(rooms[roomId].players));
        socket.emit('roomJoined', { roomId, gameMode: rooms[roomId].gameMode, players: Object.values(rooms[roomId].players) });
    });

    socket.on('leaveRoom', () => {
        handlePlayerExit(socket, 'manual');
    });

    socket.on('disconnect', () => {
        handlePlayerExit(socket, 'disconnect');
    });

    function handlePlayerExit(socket, reason) {
        const roomId = socket.roomId; const userId = socket.userId;
        console.log(`[EXIT] user ${userId} reason=${reason} room=${roomId}`);
        if (!roomId || !rooms[roomId] || !rooms[roomId].players[userId]) return;
        const room = rooms[roomId];
        const leavingName = room.players[userId].name;
        const wasPlaying = room.status === 'playing';

        delete room.players[userId];
        socket.leave(roomId); socket.roomId = null;
        reassignHost(roomId);

        io.to(roomId).emit('updateLobby', Object.values(room.players));
        const remaining = Object.keys(room.players).length;
        console.log(`[EXIT] remaining players: ${remaining}`);
        if (remaining < 2 && room.status !== 'lobby') {
            clearInterval(room.timerInterval);
            if (room.status === 'playing') {
                io.to(roomId).emit('playerLeft', leavingName);
                io.to(roomId).emit('errorMsg', 'Остался один игрок, игра завершена.');
                console.log('[EXIT] triggering showPodium due to insufficient players');
                showPodium(roomId);
            } else {
                // in prep or other stage just return to lobby
                io.to(roomId).emit('errorMsg', 'Игроков слишком мало. Возврат в лобби.');
                room.status = 'lobby'; room.puzzles = [];
                // Если хоста кикнуло, передаем права
                reassignHost(roomId);
                io.to(roomId).emit('updateLobby', Object.values(room.players));
                io.to(roomId).emit('roundEnded', 'Раунд отменен.');
            }
        }

        if (Object.keys(room.players).length === 0) {
            clearInterval(room.timerInterval);
            delete rooms[roomId];
        }
    }


    socket.on('submitPuzzle', (data) => {
        const roomId = socket.roomId; if (!roomId || !rooms[roomId]) return;
        rooms[roomId].puzzles.push({ id: Math.random().toString(36).substr(2, 9), ownerId: socket.userId, ownerName: rooms[roomId].players[socket.userId].name, imgUrl: data.imgUrl, lat: data.lat, lng: data.lng, guessedBy: [] });

        const playersCount = Object.keys(rooms[roomId].players).length;
        if (rooms[roomId].puzzles.length >= playersCount) {
            clearInterval(rooms[roomId].timerInterval); startGamePhase(roomId);
        } else {
            io.to(roomId).emit('puzzleProgress', `Загадки: ${rooms[roomId].puzzles.length} / ${playersCount}`);
            socket.emit('puzzleSubmittedSuccess'); 
        }
    });

    socket.on('syncMarker', (coords) => {
        if (socket.roomId && rooms[socket.roomId] && rooms[socket.roomId].players[socket.userId]) {
            rooms[socket.roomId].players[socket.userId].lastMarker = coords;
        }
    });

    socket.on('makeGuess', (data) => {
        const roomId = socket.roomId; if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const player = room.players[socket.userId];

        if (room.gameMode === 'blitz') {
            processBlitzGuess(roomId, socket.userId, data);
            checkEarlyFinishBlitz(roomId);
        } else {
            if (player.cooldown && Date.now() < player.cooldown) return socket.emit('errorMsg', `КД еще ${Math.ceil((player.cooldown - Date.now()) / 1000)} сек!`);
            const puzzle = room.puzzles.find(p => p.id === data.puzzleId);
            if (!puzzle) return socket.emit('errorMsg', 'Выбери фото!');
            if (puzzle.ownerId === socket.userId) return socket.emit('errorMsg', 'Свое угадывать нельзя!');
            if (puzzle.guessedBy.includes(socket.userId)) return socket.emit('errorMsg', 'Уже угадал!');

            const distance = getDistance(puzzle.lat, puzzle.lng, data.lat, data.lng);

            if (distance <= 0.1) { 
                player.score += 1; puzzle.guessedBy.push(socket.userId); 
                socket.emit('guessResult', { success: true, message: `Попадание! Ошибка: ${Math.round(distance * 1000)} м.`, distance: distance, targetLat: puzzle.lat, targetLng: puzzle.lng, puzzleId: puzzle.id });
                io.to(roomId).emit('updateLobby', Object.values(room.players));
                checkEarlyFinishClassic(roomId); 
            } else { 
                player.cooldown = Date.now() + 35000; 
                let distInfo = room.timeLeft <= 90 ? (distance < 1 ? ` Ошибка: ${Math.round(distance * 1000)} м.` : ` Ошибка: ${Math.round(distance)} км.`) : '';
                socket.emit('guessResult', { success: false, message: `Мимо!${distInfo} Штраф 35 сек.`, puzzleId: puzzle.id });
                socket.emit('startCooldown', 35); 
            }
        }
    });

    socket.on('voteContinue', () => {
        const roomId = socket.roomId; if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        if (!room.votes.includes(socket.userId)) room.votes.push(socket.userId);
        
        const onlineCount = Object.values(room.players).filter(p => p.online).length;
        if (room.votes.length >= onlineCount) {
            room.status = 'lobby'; room.puzzles = []; room.votes = [];
            for (let uid in room.players) { room.players[uid].score = 0; room.players[uid].cooldown = 0; room.players[uid].doneGuessing = false; room.players[uid].lastMarker = null;} 
            io.to(roomId).emit('updateLobby', Object.values(room.players)); io.to(roomId).emit('resetToLobby');
        } else {
            io.to(roomId).emit('voteProgress', { current: room.votes.length, total: onlineCount });
        }
    });

   socket.on('startGame', () => {
        const roomId = socket.roomId;
        const userId = socket.userId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const player = room.players[userId];

        // Лог, который скажет нам ВСЁ
        console.log(`[DEBUG] Room: ${roomId}, Status: "${room.status}", Players: ${Object.keys(room.players).length}, IsHost: ${player?.isHost}`);

        if (!player || !player.isHost) {
            return socket.emit('errorMsg', 'Только создатель с 👑 может начать игру!');
        }

        if (Object.keys(room.players).length < 2) {
            return socket.emit('errorMsg', 'Нужно минимум 2 игрока!');
        }

        // Если вдруг статус "залип", мы всё равно разрешаем старт
        if (room.status === 'lobby' || room.status === 'podium' || room.status === 'prep') {
            room.status = 'prep'; 
            room.currentRound = 1; 
            room.puzzles = []; 
            for(let uid in room.players) { 
                room.players[uid].score = 0; 
                room.players[uid].doneGuessing = false; 
            }
            console.log(`>>> ИГРА ЗАПУЩЕНА В ${roomId} <<<`);
            io.to(roomId).emit('gameStarted', { currentRound: 1, maxRounds: room.maxRounds }); 
            startRoomTimer(roomId, 300, 'prep');
        } else {
            console.log(`[!] Старт проигнорирован, статус сейчас: ${room.status}`);
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}!`));