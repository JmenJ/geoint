const io = require('socket.io-client');

// target server address (can override with SIM_SERVER env var)
const SERVER_URL = process.env.SIM_SERVER || 'http://localhost:3001';

let roomCode;
let hostSocket, guestSocket;

function createHost(name, mode) {
    const socket = io(SERVER_URL);
    const userId = 'usr_' + Math.random().toString(36).substring(2, 10);
    socket.on('connect', () => {
        console.log(`${name} connected as ${userId}`);
        socket.emit('createRoom', { playerName: name, userId, gameMode: mode });
    });
    socket.on('roomJoined', (data) => {
        console.log(`${name} roomJoined`, data);
        roomCode = data.roomId;
    });
    socket.on('gameStarted', (data) => { console.log(`${name} got gameStarted`, data); });
    socket.on('playerLeft', (n) => { console.log(`${name} sees playerLeft:`, n); });
    socket.on('startGuessingPhaseBlitz', (d) => {
        console.log(`${name} guessing phase`, d);
        // immediately submit a guess at correct coords to trigger early finish
        setTimeout(() => {
            socket.emit('makeGuess', { lat: 0, lng: 0, puzzleId: d.puzzle?.id });
        }, 500);
    });
    socket.on('blitzRoundResult', (data) => {
        console.log(`${name} received blitzRoundResult`, data);
    });
    socket.on('errorMsg', msg => { console.log(`${name} error:`, msg); });
    return socket;
}

function createJoiner(name, userId) {
    const socket = io(SERVER_URL);
    socket.on('connect', () => {
        console.log(`${name} connected`);
        socket.emit('joinRoom', { roomId: roomCode, playerName: name, userId });
    });
    socket.on('roomJoined', data => {
        console.log(`${name} joined`, data);
    });
    socket.on('startGuessingPhaseBlitz', (d) => {
        console.log(`${name} guessing phase`, d);
        setTimeout(() => {
            socket.emit('makeGuess', { lat: 0, lng: 0, puzzleId: d.puzzle?.id });
        }, 500);
    });
    socket.on('blitzRoundResult', (data) => {
        console.log(`${name} received blitzRoundResult`, data);
    });
    socket.on('errorMsg', msg => { console.log(`${name} error:`, msg); });
    return socket;
}

hostSocket = createHost('Host', 'blitz');

setTimeout(() => {
    guestSocket = createJoiner('Guest', 'usr_guest');
    setTimeout(() => {
        console.log('Host starting game');
        hostSocket.emit('startGame');
        // simulate guest leaving during play after 3s
        setTimeout(() => {
            console.log('Guest leaving mid-game');
            guestSocket.emit('leaveRoom');
        }, 3000);
    }, 2000);
}, 1000);
