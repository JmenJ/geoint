const socket = io();

const audioSuccess = new Audio('https://s3.amazonaws.com/freecodecamp/simonSound1.mp3');

const authScreen = document.getElementById('auth-screen'); const gameScreen = document.getElementById('game-screen');
const playerNameInput = document.getElementById('player-name'); const roomCodeInput = document.getElementById('room-code-input');
const displayRoomCode = document.getElementById('display-room-code'); const playersUl = document.getElementById('players-ul');
const lobbyPanel = document.getElementById('lobby-panel'); const prepPanel = document.getElementById('prep-panel'); const playPanel = document.getElementById('play-panel');
const gallery = document.getElementById('gallery'); const btnMakeGuess = document.getElementById('btn-make-guess');
const podiumOverlay = document.getElementById('podium-overlay'); const podiumList = document.getElementById('podium-list');
const btnVoteContinue = document.getElementById('btn-vote-continue'); const voteStatus = document.getElementById('vote-status');
const voteCount = document.getElementById('vote-count'); const voteTotal = document.getElementById('vote-total');
const btnStartGame = document.getElementById('btn-start-game'); // Достали кнопку старта

const roundIndicators = [document.getElementById('round-indicator'), document.getElementById('play-round-indicator')];
const classicUi = document.getElementById('classic-ui'); const blitzUi = document.getElementById('blitz-ui');
const blitzImg = document.getElementById('blitz-img'); const blitzAuthor = document.getElementById('blitz-author');

let myUserId = localStorage.getItem('geoUserId');
if (!myUserId) { myUserId = 'usr_' + Math.random().toString(36).substring(2, 10); localStorage.setItem('geoUserId', myUserId); }
const savedName = localStorage.getItem('geoPlayerName'); if (savedName) playerNameInput.value = savedName;

let selectedGameMode = 'classic'; let activePuzzleId = null; let cooldownTimer = null; let currentImageBase64 = null; 

document.getElementById('modes-container').addEventListener('click', (e) => {
    const card = e.target.closest('.mode-card.available');
    if (card) {
        document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        selectedGameMode = card.getAttribute('data-mode');
    }
});

const sidebar = document.getElementById('sidebar'); const toggleBtn = document.getElementById('toggle-sidebar');
toggleBtn.addEventListener('click', () => { sidebar.classList.toggle('collapsed'); toggleBtn.innerText = sidebar.classList.contains('collapsed') ? '▶' : '◀'; setTimeout(() => { if(map) map.invalidateSize(); }, 300); });

const savedRoomId = localStorage.getItem('geoRoomId');
if (savedRoomId) socket.emit('checkAutoReconnect', { userId: myUserId, roomId: savedRoomId });
else authScreen.classList.add('active');

const urlParams = new URLSearchParams(window.location.search); if (urlParams.get('room')) roomCodeInput.value = urlParams.get('room');

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container'); const toast = document.createElement('div');
    toast.className = `toast ${type}`; toast.innerText = message; container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
}

function formatTime(seconds) { const m = Math.floor(seconds / 60).toString().padStart(2, '0'); const s = (seconds % 60).toString().padStart(2, '0'); return `${m}:${s}`; }
function extractCoordinates(input) { const match = input.match(/(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/); if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) }; return null; }

function resetGameUI(fullReset = false) {
    if (fullReset) { 
        localStorage.removeItem('geoRoomId'); 
        authScreen.classList.add('active'); 
        gameScreen.classList.remove('active'); 
    }
    
    // Переключение панелей
    if (lobbyPanel) lobbyPanel.style.display = 'block';
    if (prepPanel) prepPanel.style.display = 'none';
    if (playPanel) playPanel.style.display = 'none';

    // Сброс форм
    const pForm = document.getElementById('puzzle-form');
    const wMsg = document.getElementById('waiting-msg');
    if (pForm) pForm.style.display = 'block';
    if (wMsg) wMsg.style.display = 'none';

    // Прячем подиум
    if (podiumOverlay) podiumOverlay.style.display = 'none';
    if (btnVoteContinue) btnVoteContinue.style.display = 'block';
    if (voteStatus) voteStatus.style.display = 'none';
    
    // БЕЗОПАСНЫЙ СБРОС ТЕКСТА (теперь не упадет!)
    const pStatus = document.getElementById('prep-status');
    if (pStatus) pStatus.innerText = 'Укажи фото и координаты.';
    
    if (voteCount) voteCount.innerText = '...';
    if (voteTotal) voteTotal.innerText = '...';
    
    roundIndicators.forEach(el => { if(el) el.style.display = 'none'; });
    
    // Очистка карты
    if (currentMarker) map.removeLayer(currentMarker);
    if (currentPolyline) map.removeLayer(currentPolyline);
    if (targetMarker) map.removeLayer(targetMarker);
    
    clearInterval(cooldownTimer);
    if (btnMakeGuess) {
        btnMakeGuess.disabled = false;
        btnMakeGuess.innerText = selectedGameMode === 'blitz' ? 'ПОДТВЕРДИТЬ' : 'Угадать!';
    }
    clearDropzone();
}

document.getElementById('btn-create-room').addEventListener('click', () => {
    const name = playerNameInput.value.trim() || 'Игрок_' + Math.floor(Math.random() * 1000);
    localStorage.setItem('geoPlayerName', name);
    socket.emit('createRoom', { playerName: name, userId: myUserId, gameMode: selectedGameMode });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
    const name = playerNameInput.value.trim() || 'Игрок_' + Math.floor(Math.random() * 1000);
    localStorage.setItem('geoPlayerName', name);
    const roomId = roomCodeInput.value.trim().toUpperCase();
    if (!roomId) return showToast('Введите код!', 'error');
    socket.emit('joinRoom', { roomId, playerName: name, userId: myUserId });
});

document.getElementById('btn-copy-link').addEventListener('click', () => { navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?room=${displayRoomCode.innerText}`).then(() => showToast('✅ Ссылка скопирована!')); });
btnStartGame.addEventListener('click', () => {
    // client-side guard: require at least two players
    const count = playersUl ? playersUl.children.length : 0;
    if (count < 2) {
        showToast('Нужно минимум 2 игрока для старта!', 'error');
        return;
    }
    socket.emit('startGame');
});

// DROPZONE
const dropzone = document.getElementById('dropzone'); const fileInput = document.getElementById('file-input'); const preview = document.getElementById('dropzone-preview'); const clearBtn = document.getElementById('dropzone-clear');
dropzone.addEventListener('click', (e) => { if(e.target !== clearBtn) fileInput.click(); });
fileInput.addEventListener('change', (e) => handleImageFile(e.target.files[0]));
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); if (e.dataTransfer.files.length) handleImageFile(e.dataTransfer.files[0]); });
document.addEventListener('paste', (e) => { if (prepPanel.style.display !== 'none') { for (let item of e.clipboardData.items) { if (item.type.indexOf('image') !== -1) { handleImageFile(item.getAsFile()); break; } } } });
clearBtn.addEventListener('click', clearDropzone);
function clearDropzone() { currentImageBase64 = null; preview.src = ''; preview.style.display = 'none'; clearBtn.style.display = 'none'; fileInput.value = ''; }
function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return showToast('Это не картинка!', 'error');
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image(); img.onload = () => {
            const canvas = document.createElement('canvas'); const MAX_WIDTH = 800; let width = img.width; let height = img.height;
            if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
            canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
            currentImageBase64 = canvas.toDataURL('image/jpeg', 0.8); preview.src = currentImageBase64; preview.style.display = 'block'; clearBtn.style.display = 'block'; showToast('Фото загружено!', 'success');
        }; img.src = e.target.result;
    }; reader.readAsDataURL(file);
}

// СЕТЬ
socket.on('roomJoined', (data) => {
    selectedGameMode = data.gameMode;
    localStorage.setItem('geoRoomId', data.roomId); authScreen.classList.remove('active'); gameScreen.classList.add('active');
    displayRoomCode.innerText = data.roomId; updatePlayersList(data.players); window.history.pushState({}, '', `?room=${data.roomId}`);
    setTimeout(initMap, 200);
});

socket.on('reconnectSuccess', (data) => {
    selectedGameMode = data.gameMode;
    authScreen.classList.remove('active'); gameScreen.classList.add('active');
    displayRoomCode.innerText = data.roomId; updatePlayersList(data.players); setTimeout(initMap, 200); showToast('Восстановление...', 'success');
    if (data.status === 'prep') { 
        showPrepPhase(data.currentRound, data.maxRounds); 
    } 
    else if (data.status === 'playing') { 
        if (selectedGameMode === 'blitz') showBlitzPhase(data.assignedPuzzle, data.currentRound, data.maxRounds);
        else showClassicPhase(data.puzzles);
    }
});

socket.on('reconnectFailed', () => resetGameUI(true));
socket.on('updateLobby', updatePlayersList);
socket.on('errorMsg', (msg) => showToast(msg, 'error'));
socket.on('kicked', (msg) => { showToast(msg, 'error'); resetGameUI(true); });

// someone left mid-game
socket.on('playerLeft', (name) => {
    showToast(`${name} вышел`, 'info');
});


socket.on('timerTick', (data) => {
    const timeStr = formatTime(data.time);
    if (data.stage === 'prep') document.getElementById('prep-timer').innerText = `⏳ ${timeStr}`;
    else if (data.stage === 'playing') document.getElementById('play-timer').innerText = `⏱ ${timeStr}`;
});

function showPrepPhase(curr, max) {
    resetGameUI(); 
    lobbyPanel.style.display = 'none'; prepPanel.style.display = 'block';
    if (max > 1) {
        roundIndicators[0].style.display = 'block'; roundIndicators[0].innerText = `Раунд ${curr}/${max}`;
    }
}

socket.on('gameStarted', (data) => {
    console.log("!!! Команда от сервера получена:", data);
    showPrepPhase(data.currentRound, data.maxRounds); 
    showToast('Игра началась! Загадывай.', 'success'); 
});
socket.on('nextRoundPrep', (data) => { showPrepPhase(data.currentRound, data.maxRounds); showToast(`Раунд ${data.currentRound}! Загадай новую локацию.`, 'success'); });

socket.on('puzzleProgress', (msg) => document.getElementById('prep-status').innerText = msg);
socket.on('puzzleSubmittedSuccess', () => { document.getElementById('puzzle-form').style.display = 'none'; document.getElementById('waiting-msg').style.display = 'block'; document.getElementById('coord-input').value = ''; clearDropzone(); });

function showClassicPhase(puzzles) {
    prepPanel.style.display = 'none'; playPanel.style.display = 'block'; classicUi.style.display = 'block'; blitzUi.style.display = 'none';
    btnMakeGuess.innerText = 'Угадать!';
    document.getElementById('guess-desc').innerText = 'Выбери фото, поставь метку и жми угадать.';
    renderGallery(puzzles);
}

function showBlitzPhase(puzzle, curr, max) {
    prepPanel.style.display = 'none'; playPanel.style.display = 'block'; classicUi.style.display = 'none'; blitzUi.style.display = 'block';
    roundIndicators[1].style.display = 'block'; roundIndicators[1].innerText = `Раунд ${curr}/${max}`;
    btnMakeGuess.innerText = 'ПОДТВЕРДИТЬ'; btnMakeGuess.disabled = false;
    document.getElementById('guess-desc').innerText = 'Поставь метку и нажми Подтвердить. У тебя 1 попытка!';
    
    if (puzzle) { blitzImg.src = puzzle.imgUrl; blitzAuthor.innerText = `Локация игрока: ${puzzle.ownerName}`; }
}

// показываем промежуточный результат в блиц режиме
function showBlitzRoundResult(players, curr, max) {
    podiumList.innerHTML = '';
    players.forEach((p, idx) => {
        const li = document.createElement('li');
        let icon = `${idx+1}.`;
        if (idx === 0) icon = '🥇';
        else if (idx === 1) icon = '🥈';
        else if (idx === 2) icon = '🥉';
        li.innerHTML = `<span>${icon} ${p.name}</span> <span>${p.score}</span>`;
        podiumList.appendChild(li);
    });
    const title = curr < max ? `Результаты раунда ${curr}` : '🏆 Итоги турнира 🏆';
    podiumOverlay.querySelector('h1').innerText = title;
    if (curr < max) {
        btnVoteContinue.style.display = 'none';
        voteStatus.style.display = 'none';
    }
    podiumOverlay.style.display = 'flex';
}

socket.on('startGuessingPhaseClassic', (puzzles) => { showClassicPhase(puzzles); showToast('У вас 5 минут!', 'success'); });
socket.on('startGuessingPhaseBlitz', (data) => { showBlitzPhase(data.puzzle, data.currentRound, data.maxRounds); showToast('БЛИЦ! У вас 1:30', 'info'); });

socket.on('startCooldown', (seconds) => {
    btnMakeGuess.disabled = true; let left = seconds; btnMakeGuess.innerText = `Штраф: ${left} сек`;
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => { left--; if (left <= 0) { clearInterval(cooldownTimer); btnMakeGuess.disabled = false; btnMakeGuess.innerText = 'Угадать!'; } else { btnMakeGuess.innerText = `Штраф: ${left} сек`; } }, 1000);
});

socket.on('guessResult', (data) => {
    if (data.success) {
        showToast('🎯 ' + data.message, 'success');
        audioSuccess.play().catch(e => console.log('Аудио заблокировано браузером'));
        const item = document.getElementById('puzzle-' + data.puzzleId);
        if(item) { item.classList.add('guessed'); item.classList.remove('selected'); activePuzzleId = null; }
        if (currentMarker && data.targetLat) drawResultLine(currentMarker.getLatLng().lat, currentMarker.getLatLng().lng, data.targetLat, data.targetLng, data.distance);
    } else { showToast('❌ ' + data.message, 'error'); }
});

socket.on('blitzResult', (data) => {
    audioSuccess.play().catch(e => console.log('Аудио заблокировано браузером'));
    btnMakeGuess.disabled = true;
    btnMakeGuess.innerText = `Ожидание... (+${data.points} очков)`;
    if (currentMarker && data.targetLat) drawResultLine(currentMarker.getLatLng().lat, currentMarker.getLatLng().lng, data.targetLat, data.targetLng, data.distance);
});

socket.on('showPodium', (playersSorted) => {
    podiumList.innerHTML = '';
    playersSorted.forEach((p, index) => {
        const li = document.createElement('li'); let icon = '🏅'; if (index === 0) icon = '🥇'; else if (index === 1) icon = '🥈'; else if (index === 2) icon = '🥉';
        li.innerHTML = `<span>${icon} ${p.name}</span> <span>${p.score}</span>`; 
        podiumList.appendChild(li);
    });
    // в конце показываем кнопку голосования и статус
    btnVoteContinue.style.display = 'block';
    voteStatus.style.display = 'none';
    podiumOverlay.style.display = 'flex'; 
});

btnVoteContinue.addEventListener('click', () => { 
    socket.emit('voteContinue'); 
    btnVoteContinue.style.display = 'none'; 
    voteStatus.style.display = 'block'; 
    voteCount.innerText = '...'; 
    voteTotal.innerText = '...'; 
});

socket.on('voteProgress', (data) => { 
    voteCount.innerText = data.current; 
    voteTotal.innerText = data.total; 
    if (btnVoteContinue.style.display === 'none') voteStatus.style.display = 'block'; 
});

// interim blitz round results
socket.on('blitzRoundResult', (data) => {
    showBlitzRoundResult(data.players, data.currentRound, data.maxRounds);
});

socket.on('resetToLobby', () => { resetGameUI(); showToast('Все готовы!', 'success'); });

// exit button inside map
const btnExitGame = document.getElementById('btn-exit-game');
if (btnExitGame) btnExitGame.addEventListener('click', () => { socket.emit('leaveRoom'); resetGameUI(true); });

// ИСПРАВЛЕНА ЛОГИКА ОТОБРАЖЕНИЯ ИГРОКОВ (Добавили 👑 и скрытие кнопки)
function updatePlayersList(players) {
    playersUl.innerHTML = '';
    let amIHost = false;
    
    players.forEach(p => {
        if (p.id === myUserId && p.isHost) amIHost = true;
        
        const li = document.createElement('li');
        const hostIcon = p.isHost ? '<span style="color:#f59e0b" title="Создатель комнаты">👑</span> ' : '';
        li.innerHTML = `<span>${p.online ? '🟢' : '🔴'} ${hostIcon}<b>${p.name}</b></span> <span style="color:#4ade80; font-weight:bold;">${p.score}</span>`;
        playersUl.appendChild(li);
    });

    // Показываем кнопку "Начать" ТОЛЬКО хосту
    if (amIHost) {
        btnStartGame.style.display = 'block';
        // отключаем, если игроков меньше двух
        btnStartGame.disabled = players.length < 2;
    } else {
        btnStartGame.style.display = 'none';
    }
}

function renderGallery(puzzles) {
    gallery.innerHTML = ''; activePuzzleId = null;
    puzzles.forEach(p => {
        // защитимся ещё и на клиенте (сервер уже фильтрует)
        if (p.ownerId === myUserId) return; 
        const isGuessed = p.guessedBy.includes(myUserId);
        const div = document.createElement('div'); div.id = 'puzzle-' + p.id; div.className = `gallery-item ${isGuessed ? 'guessed' : ''}`;
        div.innerHTML = `<img src="${p.imgUrl}" alt="Photo" style="width: 100%; height: 60px; object-fit: cover;" onerror="this.src='https://via.placeholder.com/80?text=No+Photo'"><div style="font-size: 10px; padding: 2px; background: #3b3b54; color: white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.ownerName}</div>`;
        if (!isGuessed) { div.onclick = () => { document.querySelectorAll('.gallery-item').forEach(el => el.classList.remove('selected')); div.classList.add('selected'); activePuzzleId = p.id; showToast(`Выбрана локация: ${p.ownerName}`); }; }
        gallery.appendChild(div);
    });
}

let map; let currentMarker = null; let currentPolyline = null; let targetMarker = null;

function initMap() {
    if (map) return; map = L.map('map').setView([55.75, 37.61], 4); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);
    map.on('click', function(e) { 
        if (currentMarker) map.removeLayer(currentMarker); 
        currentMarker = L.marker(e.latlng).addTo(map); 
        socket.emit('syncMarker', {lat: e.latlng.lat, lng: e.latlng.lng}); 
    });
}

function drawResultLine(gLat, gLng, tLat, tLng, distance) {
    if (currentPolyline) map.removeLayer(currentPolyline); if (targetMarker) map.removeLayer(targetMarker);
    targetMarker = L.circleMarker([tLat, tLng], {color: 'green', radius: 8}).addTo(map);
    currentPolyline = L.polyline([[gLat, gLng], [tLat, tLng]], { color: 'red', weight: 3, dashArray: '10, 10' }).addTo(map); map.fitBounds(currentPolyline.getBounds(), { padding: [50, 50] });
    const distText = distance < 1 ? `${Math.round(distance * 1000)} м` : `${Math.round(distance)} км`;
    currentPolyline.bindTooltip(`Расстояние: ${distText}`, {permanent: true}).openTooltip();
}

document.getElementById('btn-submit-puzzle').addEventListener('click', () => {
    const coordRaw = document.getElementById('coord-input').value;
    if (!currentImageBase64) return showToast('Загрузи фото!', 'error'); if (!coordRaw) return showToast('Вставь координаты!', 'error');
    const coords = extractCoordinates(coordRaw); if (!coords) return showToast('Кривые координаты!', 'error');
    socket.emit('submitPuzzle', { imgUrl: currentImageBase64, lat: coords.lat, lng: coords.lng });
});

btnMakeGuess.addEventListener('click', () => {
    if (btnMakeGuess.disabled) return;
    if (!currentMarker) return showToast('Поставь метку на карте кликом!', 'error');
    
    if (selectedGameMode === 'blitz') {
        socket.emit('makeGuess', { lat: currentMarker.getLatLng().lat, lng: currentMarker.getLatLng().lng });
    } else {
        if (!activePuzzleId) return showToast('Сначала выбери фото из галереи!', 'error');
        socket.emit('makeGuess', { puzzleId: activePuzzleId, lat: currentMarker.getLatLng().lat, lng: currentMarker.getLatLng().lng });
    }
});