const $ = selector => document.querySelector(selector);
const grid = $('#songGrid');
const library = $('#libraryView');
const gameView = $('#gameView');
const frame = $('#gameFrame');
const audio = $('#songAudio');
const defaults = {gain: 0, gate: -55, bassGain: 1, midGain: 1, highGain: 1, release: 20, sensitivity: 1, laneTime: .44, moveInterval: .8};
const settings = Object.assign({}, defaults, JSON.parse(localStorage.getItem('i404.web.settings') || '{}'));
settings.laneTime = .44;
const overrides = JSON.parse(localStorage.getItem('i404.web.songs') || '{}');

let songs = [], selected = null, dev = false, editing = null;
let ctx = null, analyser = null, mediaSource = null, freq, timeData;
let capture = false, resumeAudioAfterPause = false, raf = 0;
let pendingStart = null;
let timer = 0, countTimer = 0, resetTimer = 0, transitionTimer = 0, frameWatchdog = 0;
let session = 0, playbackRequest = 0, pendingMode = 'manual', frameReady = false;
let started = false, paused = false, score = 0, fuel = 100, deaths = 0;
let lowFuelAt = null, lowFuelSpeed = 504, emptyAt = null;
let lastFrame = 0, deathResetPending = false, spaceHeld = false;
let lastSceneTime = -1, lastSceneProgressAt = 0;
const levels = [0, 0, 0], peaks = [0, 0, 0], dirs = [0, 0, 0], pulses = [0, 0, 0], previous = [0, 0, 0];

fetch('songs.json').then(response => response.json()).then(data => {
  songs = data.map(song => Object.assign({}, song, overrides[song.id] || {}));
  renderLibrary();
}).catch(() => { grid.textContent = 'Could not load the song list.'; });

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

function renderLibrary() {
  grid.innerHTML = '';
  $('#songCount').textContent = songs.length + ' TRACKS';
  songs.forEach(song => {
    const card = document.createElement('article');
    card.className = 'song-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.innerHTML = '<div class="cover-wrap"><img loading="lazy" src="assets/covers/' + esc(song.coverPath) + '" alt="' + esc(song.title) + ' cover"></div><strong class="song-title">' + esc(song.title) + '</strong><span class="song-artist">' + esc(song.artist) + '</span><button class="edit-track" type="button">EDIT</button>';
    card.onclick = () => choose(song);
    card.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); choose(song); } };
    card.querySelector('.edit-track').onclick = event => { event.stopPropagation(); editSong(song); };
    grid.append(card);
  });
  document.body.classList.toggle('dev-mode', dev);
}

function status(message) {
  $('#audioStatus').textContent = message;
  $('#audioStatus').classList.toggle('live', message.startsWith('AUDIO ACTIVE'));
}

function resetAnalysis() {
  [levels, peaks, dirs, pulses, previous].forEach(values => values.fill(0));
}

function stopCapture(resetPosition = false) {
  playbackRequest++;
  pendingStart = null;
  capture = false;
  cancelAnimationFrame(raf);
  audio.pause();
  if (resetPosition) { try { audio.currentTime = 0; } catch {} }
  $('#listenButton').textContent = 'PLAY SONG';
  status('AUDIO PAUSED');
}

function clearGameTimers() {
  clearInterval(timer);
  clearInterval(countTimer);
  clearTimeout(resetTimer);
  clearTimeout(transitionTimer);
  clearTimeout(frameWatchdog);
  timer = countTimer = resetTimer = transitionTimer = frameWatchdog = 0;
}

function releaseInputs() {
  spaceHeld = false;
  applyBoost();
}

function cleanGameView() {
  for (const id of ['pauseOverlay', 'settingsOverlay', 'songEndOverlay', 'outOfFuelOverlay', 'countdown', 'fuelHud', 'scoreHud', 'pauseButtonWrap', 'whiteTransition']) {
    $("#" + id).hidden = true;
  }
  $('#outOfFuelOverlay').classList.remove('fade-out');
  $('#whiteTransition').classList.remove('reveal');
  $('#scoreHud').textContent = '000000';
  $('#fuelFill').style.width = '100%';
  resumeAudioAfterPause = false;
}

function attachTrackAudio(song) {
  stopCapture(true);
  audio.removeAttribute('src');
  audio.load();
  resetAnalysis();
  audio.src = song.audioPath;
  audio.load();
  $('#listenButton').disabled = true;
  $('#listenButton').hidden = true;
  status('TRACK READY');
}

function loadFrame(mode, attempt = 0) {
  const id = ++session;
  pendingMode = mode;
  frameReady = false;
  lastFrame = 0;
  lastSceneTime = -1;
  lastSceneProgressAt = performance.now();
  releaseInputs();
  clearInterval(timer);
  clearTimeout(frameWatchdog);
  frame.style.opacity = '0';
  frame.onload = () => {
    if (id !== session || frame.src.endsWith('about:blank')) return;
    bindFrameControls();
    clearInterval(timer);
    timer = setInterval(tick, 50);
    tick();
  };
  frame.src = 'game/sample-index.html?run=' + id + '-' + Date.now();
  frameWatchdog = setTimeout(() => {
    if (id !== session || frameReady || gameView.hidden) return;
    if (attempt < 2) loadFrame(mode, attempt + 1);
    else $('#gameStatus').textContent = 'Game did not load. Choose another song and try again.';
  }, 12000);
}

function choose(song) {
  clearGameTimers();
  stopCapture(true);
  cleanGameView();
  selected = song;
  started = false;
  paused = false;
  score = 0;
  deaths = 0;
  fuel = 100;
  emptyAt = lowFuelAt = null;
  deathResetPending = false;
  settings.laneTime = .44;
  renderSettings();
  library.hidden = true;
  gameView.hidden = false;
  $('#selectedTitle').textContent = song.title;
  $('#selectedArtist').textContent = song.artist;
  $('#gameStatus').textContent = 'Loading track…';
  attachTrackAudio(song);
  loadFrame('manual');
  primeSong();
}

function game() {
  try { return frame.contentWindow.gs.Game.current; } catch { return null; }
}

function get(object, key, fallback = 0) {
  try {
    const value = Number(object.attributes[key].getValue());
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}

function set(object, key, value) {
  try {
    const attribute = object && object.attributes[key];
    if (attribute && attribute.setValue) attribute.setValue(value);
  } catch {}
}

function enginePause(value) {
  try { if (value) frame.contentWindow.gse.pause(); else frame.contentWindow.gse.unpause(); } catch {}
}

function hideUI(currentGame) {
  if (!currentGame || !currentGame.currentScene) return;
  (currentGame.currentScene.layers || []).forEach((layer, index) => {
    for (const actor of layer.actors || []) {
      const name = actor.attributes.name?.getValue ? String(actor.attributes.name.getValue()) : '';
      if (index !== 3 && !name.startsWith('UI - ')) continue;
      actor.aspects?.graphics?.attributes?.visible?.setValue(false);
    }
  });
}

function initializeGame(withCountdown) {
  const currentGame = game();
  if (!currentGame || !currentGame.currentScene) return false;
  const time = get(currentGame.currentScene, 'time', 0);
  const values = {
    idGState: 1, idGLane: 3, idGPlayerY: 321, idGRoadSpeed: 504, idGMPH: 181,
    idGBoost: 0, idGDifficulty: 0, idGPassed: 0, idGSeconds: 0,
    idGAirborne: 0, idGJumpHeight: 0, idGStoryStep: 0, idGJumps: 0,
    idHealth: 4, idDamageUntil: 0, idNativeBoost: 0, idWreckTime: -100, idFuel: 100
  };
  Object.entries(values).forEach(([key, value]) => set(currentGame, key, value));
  set(currentGame, 'idGStarted', time);
  set(currentGame, 'idGNextSecond', time + 1);
  set(currentGame, 'idGRunSeed', Math.floor(time * 1e6) + 95);
  hideUI(currentGame);
  started = true;
  paused = withCountdown;
  fuel = 100;
  lowFuelAt = emptyAt = null;
  deathResetPending = false;
  lastFrame = performance.now();
  $('#fuelFill').style.width = '100%';
  $('#fuelHud').hidden = false;
  $('#scoreHud').hidden = false;
  $('#pauseButtonWrap').hidden = false;
  if (withCountdown) {
    enginePause(true);
    countdown();
  } else {
    enginePause(false);
    $('#gameStatus').textContent = 'W & S TO SWITCH LANES. SPACE TO ACCELERATE';
  }
  return true;
}

function countdown() {
  const id = session;
  let number = 3;
  const display = $('#countdown');
  display.textContent = number;
  display.hidden = false;
  clearInterval(countTimer);
  countTimer = setInterval(() => {
    if (id !== session || $('#songEndOverlay').hidden === false) { clearInterval(countTimer); return; }
    number--;
    if (number <= 0) {
      clearInterval(countTimer);
      display.hidden = true;
      paused = false;
      lastFrame = performance.now();
      lastSceneProgressAt = lastFrame;
      enginePause(false);
      $('#gameStatus').textContent = 'W & S TO SWITCH LANES. SPACE TO ACCELERATE';
    } else display.textContent = number;
  }, 450);
}

function revealTransition(afterReveal) {
  const id = session;
  const layer = $('#whiteTransition');
  layer.classList.add('reveal');
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    if (id !== session) return;
    layer.hidden = true;
    layer.classList.remove('reveal');
    layer.style.background = '';
    if (afterReveal) afterReveal();
  }, 260);
}

function tick() {
  if (gameView.hidden || !selected) return;
  const currentGame = game();
  if (!currentGame || !currentGame.currentScene) { status('LOADING GAME'); return; }
  const now = performance.now();
  const sceneTime = get(currentGame.currentScene, 'time', -1);
  if (sceneTime > lastSceneTime + .001) {
    lastSceneTime = sceneTime;
    lastSceneProgressAt = now;
  }
  if (!frameReady) {
    // The GameSalad scene exists before its actors finish their startup rules.
    // Wait for the scene clock so those rules cannot overwrite our run state.
    if (sceneTime < .08) return;
    frameReady = true;
    clearTimeout(frameWatchdog);
    hideUI(currentGame);
    frame.style.opacity = '1';
    if (pendingMode === 'manual') startSongAfterPaint();
    if (pendingMode === 'replay') revealTransition(startSongAfterPaint);
    else if (pendingMode === 'continue') {
      initializeGame(false);
      revealTransition();
    }
    pendingMode = 'running';
  }
  hideUI(currentGame);
  const dt = lastFrame ? Math.min(.25, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  if (started && !paused && capture && !document.hidden && now - lastSceneProgressAt > 1800) {
    resetScene(false);
    return;
  }
  if (started && !paused && pendingMode === 'running' && get(currentGame, 'idGState') === 0) {
    initializeGame(false);
  }
  if (capture && !started && audible()) initializeGame(true);
  applyBoost();
  const state = get(currentGame, 'idGState');
  if (started && !paused && state === 1) {
    const speed = get(currentGame, 'idGRoadSpeed', 504);
    score += speed * dt / 30;
    $('#scoreHud').textContent = String(Math.floor(score)).padStart(6, '0');
    const engineFuel = get(currentGame, 'idFuel', fuel);
    if (engineFuel > fuel + 1) fuel = Math.min(100, engineFuel);
    if (get(currentGame, 'idGBoost') > .5 && fuel > 0) fuel = Math.max(0, fuel - dt * 5);
    if (fuel <= 3 && fuel > 0) {
      if (lowFuelAt === null) { lowFuelAt = now; lowFuelSpeed = speed; }
      const progress = Math.min(1, (now - lowFuelAt) / 600);
      const coast = 90 + (Math.max(90, lowFuelSpeed) - 90) * Math.pow(1 - progress, 1.35);
      set(currentGame, 'idGRoadSpeed', coast);
      set(currentGame, 'idGMPH', Math.round(Math.max(0, coast - 90) * 3.6));
    }
    set(currentGame, 'idFuel', fuel);
    $('#fuelFill').style.width = fuel + '%';
  }
  if (started && !paused && state === 2 && !deathResetPending && $('#songEndOverlay').hidden) {
    deaths++;
    deathResetPending = true;
    const id = session;
    resetTimer = setTimeout(() => { if (id === session && $('#songEndOverlay').hidden) resetScene(false); }, 500);
  }
  if (started && !paused && fuel <= 0 && emptyAt === null) {
    deaths++;
    emptyAt = now;
    paused = true;
    releaseInputs();
    $('#pauseOverlay').hidden = true;
    $('#settingsOverlay').hidden = true;
    $('#outOfFuelOverlay').hidden = false;
    enginePause(true);
    const id = session;
    resetTimer = setTimeout(() => { if (id === session && $('#songEndOverlay').hidden) resetScene(true); }, 1000);
  }
}

function resetScene(outOfFuel) {
  if (!selected || !$('#songEndOverlay').hidden) return;
  paused = true;
  releaseInputs();
  $('#pauseOverlay').hidden = true;
  $('#settingsOverlay').hidden = true;
  $('#outOfFuelOverlay').hidden = true;
  const layer = $('#whiteTransition');
  layer.style.background = '#000';
  layer.classList.remove('reveal');
  layer.hidden = false;
  if (outOfFuel) $('#gameStatus').textContent = 'BACK ON THE ROAD';
  loadFrame('continue');
}

function finishSong() {
  if (!selected || !started || !$('#songEndOverlay').hidden) return;
  clearTimeout(resetTimer);
  clearInterval(countTimer);
  releaseInputs();
  paused = true;
  stopCapture();
  resumeAudioAfterPause = false;
  enginePause(true);
  $('#pauseOverlay').hidden = true;
  $('#settingsOverlay').hidden = true;
  $('#outOfFuelOverlay').hidden = true;
  $('#whiteTransition').hidden = true;
  $('#pauseButtonWrap').hidden = true;
  $('#finalScore').textContent = 'SCORE ' + String(Math.floor(score)).padStart(6, '0') + ' · DEATHS ' + deaths;
  $('#songEndOverlay').hidden = false;
}

function audible() { return levels.some(value => value > .035); }

function analyze() {
  if (!capture || !analyser || !ctx) return;
  analyser.getFloatFrequencyData(freq);
  analyser.getFloatTimeDomainData(timeData);
  let rms = 0;
  for (const value of timeData) rms += value * value;
  rms = Math.sqrt(rms / timeData.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-9)) + settings.gain;
  const gate = db > settings.gate;
  const sampleRate = ctx.sampleRate;
  const bounds = [[20, 250], [250, 4000], [4000, 20000]];
  const gains = [settings.bassGain, settings.midGain, settings.highGain];
  const output = [];
  for (let band = 0; band < 3; band++) {
    const low = Math.max(1, Math.floor(bounds[band][0] * analyser.fftSize / sampleRate));
    const high = Math.min(freq.length - 1, Math.ceil(bounds[band][1] * analyser.fftSize / sampleRate));
    let power = 0, count = 0;
    for (let index = low; index <= high; index++) {
      const amplitude = Math.pow(10, freq[index] / 20);
      power += amplitude * amplitude;
      count++;
    }
    const bandDb = 10 * Math.log10(Math.max(power / Math.max(1, count), 1e-12)) + settings.gain;
    const target = gate && gains[band] > 0 ? 1 - Math.exp(-Math.max(0, (bandDb + 60) / 60) * gains[band]) : 0;
    const milliseconds = target > levels[band] ? 8 : settings.release;
    const alpha = 1 - Math.exp(-1 / 60 / (Math.max(1, milliseconds) / 1000));
    const value = levels[band] + alpha * (target - levels[band]);
    const change = value - previous[band];
    const threshold = .02 / Math.max(.1, settings.sensitivity);
    if (dirs[band] >= 0) {
      if (value > peaks[band]) peaks[band] = value;
      if (value < peaks[band] - threshold) { dirs[band] = -1; peaks[band] = value; pulses[band]++; }
      else if (dirs[band] === 0 && value > threshold) { dirs[band] = 1; pulses[band]++; }
    } else {
      if (value < peaks[band]) peaks[band] = value;
      if (value > peaks[band] + threshold) { dirs[band] = 1; peaks[band] = value; pulses[band]++; }
    }
    levels[band] = gate ? value : 0;
    previous[band] = value;
    output.push({value, sharpness: Math.min(1, Math.max(.15, Math.abs(change) * 60 / .5))});
  }
  const currentGame = game();
  if (currentGame) {
    const values = {
      idAudioBass: output[0].value, idAudioMid: output[1].value, idAudioHigh: output[2].value,
      idAudioConnected: 1, idAudioBassPulse: pulses[0], idAudioMidPulse: pulses[1], idAudioHighPulse: pulses[2],
      idAudioBassSharpness: output[0].sharpness, idAudioMidSharpness: output[1].sharpness, idAudioHighSharpness: output[2].sharpness,
      idAudioBassDirection: dirs[0], idAudioMidDirection: dirs[1], idAudioHighDirection: dirs[2],
      idTrafficActive: gate ? 1 : 0, idTrafficMoveInterval: settings.moveInterval, idTrafficLaneTime: .44
    };
    Object.entries(values).forEach(([key, value]) => set(currentGame, key, value));
  }
  status(gate ? 'AUDIO ACTIVE · BASS ' + Math.round(levels[0] * 100) + ' · MID ' + Math.round(levels[1] * 100) + ' · TREBLE ' + Math.round(levels[2] * 100) : 'TRACK QUIET · WAITING FOR AUDIO');
  raf = requestAnimationFrame(analyze);
}

function ensureAudioGraph() {
  if (ctx) return;
  ctx = new AudioContext();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  freq = new Float32Array(analyser.frequencyBinCount);
  timeData = new Float32Array(analyser.fftSize);
  mediaSource = ctx.createMediaElementSource(audio);
  mediaSource.connect(analyser);
  analyser.connect(ctx.destination);
}

function primeSong() {
  if (!selected || !audio.getAttribute('src')) return;
  // This runs in the album/replay click. Keep the track silent while the game loads;
  // browsers permit the later reveal because playback began with user activation.
  try {
    ensureAudioGraph();
    audio.volume = 0;
    const resumed = ctx.resume();
    const playing = audio.play();
    pendingStart = Promise.all([resumed, playing]).then(() => true).catch(() => false);
  } catch {
    pendingStart = Promise.resolve(false);
  }
}

function startSongAfterPaint() {
  const id = session;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (id === session && selected && !gameView.hidden) startPreparedSong();
  }));
}

async function startPreparedSong() {
  const id = session;
  const request = playbackRequest;
  const ready = pendingStart && await pendingStart;
  if (id !== session || request !== playbackRequest || !selected) return;
  pendingStart = null;
  if (!ready || audio.paused) {
    $('#listenButton').hidden = false;
    $('#listenButton').disabled = false;
    status('PRESS PLAY SONG TO START AUDIO');
    return;
  }
  try { audio.currentTime = 0; } catch {}
  audio.volume = 1;
  capture = true;
  $('#listenButton').textContent = 'PAUSE SONG';
  $('#listenButton').hidden = false;
  $('#listenButton').disabled = false;
  status('WAITING FOR MUSIC SIGNAL');
  cancelAnimationFrame(raf);
  analyze();
}

async function playSong() {
  if (!selected || !audio.getAttribute('src')) { status('TRACK AUDIO IS NOT AVAILABLE'); return false; }
  const id = session;
  const request = ++playbackRequest;
  try {
    ensureAudioGraph();
    await ctx.resume();
    if (id !== session || request !== playbackRequest) return false;
    if (audio.ended) audio.currentTime = 0;
    audio.volume = 1;
    await audio.play();
    if (id !== session || request !== playbackRequest) return false;
    capture = true;
    $('#listenButton').textContent = 'PAUSE SONG';
    $('#listenButton').hidden = false;
    $('#listenButton').disabled = false;
    status('WAITING FOR MUSIC SIGNAL');
    cancelAnimationFrame(raf);
    analyze();
    return true;
  } catch {
    if (id === session && request === playbackRequest) {
      capture = false;
      status('COULD NOT PLAY TRACK AUDIO');
    }
    return false;
  }
}

async function pauseGame(value) {
  if (!started || !selected || !$('#songEndOverlay').hidden || !$('#outOfFuelOverlay').hidden) return;
  if (value) {
    paused = true;
    resumeAudioAfterPause = capture && !audio.paused;
    stopCapture();
    releaseInputs();
    enginePause(true);
    $('#settingsOverlay').hidden = true;
    $('#pauseOverlay').hidden = false;
    $('#pauseButtonWrap').hidden = true;
    return;
  }
  const id = session;
  if (resumeAudioAfterPause) {
    const played = await playSong();
    if (id !== session) return;
    if (!played) { status('COULD NOT RESUME TRACK AUDIO'); return; }
  }
  resumeAudioAfterPause = false;
  $('#settingsOverlay').hidden = true;
  $('#pauseOverlay').hidden = true;
  $('#pauseButtonWrap').hidden = false;
  paused = false;
  lastFrame = performance.now();
  lastSceneProgressAt = lastFrame;
  enginePause(false);
}

function backToLibrary() {
  ++session;
  clearGameTimers();
  releaseInputs();
  stopCapture(true);
  audio.removeAttribute('src');
  audio.load();
  resetAnalysis();
  frame.onload = null;
  frame.src = 'about:blank';
  frameReady = false;
  selected = null;
  started = false;
  paused = false;
  cleanGameView();
  gameView.hidden = true;
  library.hidden = false;
  $('#listenButton').disabled = true;
  $('#listenButton').hidden = true;
  status('AUDIO NOT CONNECTED');
}

function restart() {
  if (!selected) return;
  clearGameTimers();
  releaseInputs();
  stopCapture(true);
  resetAnalysis();
  cleanGameView();
  $('#listenButton').disabled = true;
  $('#listenButton').hidden = true;
  started = false;
  paused = false;
  score = 0;
  deaths = 0;
  fuel = 100;
  emptyAt = lowFuelAt = null;
  deathResetPending = false;
  const layer = $('#whiteTransition');
  layer.style.background = '#fff';
  layer.hidden = false;
  $('#gameStatus').textContent = 'Loading game…';
  loadFrame('replay');
  primeSong();
}

function applyBoost() {
  const active = started && !paused && spaceHeld && $('#songEndOverlay').hidden;
  set(game(), 'idNativeBoost', active ? 1 : 0);
  set(game(), 'idGBoost', active ? 1 : 0);
}

function onKeyDown(event) {
  if (gameView.hidden || !selected) return;
  if (event.code === 'KeyW' || event.code === 'KeyS') {
    if (started && !paused && !event.repeat) {
      const currentGame = game();
      if (currentGame && get(currentGame, 'idGState') === 1) {
        const lane = Math.round(get(currentGame, 'idGLane', 3));
        set(currentGame, 'idGLane', Math.max(1, Math.min(6, lane + (event.code === 'KeyW' ? 1 : -1))));
      }
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.code === 'Escape') {
    event.preventDefault();
    if (event.repeat) return;
    if (!$('#settingsOverlay').hidden) { $('#settingsDone').click(); return; }
    if (started) pauseGame(!paused);
  } else if (event.code === 'Space' && started && !paused) {
    event.preventDefault();
    spaceHeld = true;
    applyBoost();
  }
}

function onKeyUp(event) {
  if (event.code === 'Space') { spaceHeld = false; applyBoost(); }
}

function bindFrameControls() {
  try {
    const inner = frame.contentWindow;
    inner.addEventListener('blur', releaseInputs);
    inner.addEventListener('keydown', onKeyDown, true);
    inner.addEventListener('keyup', onKeyUp, true);
  } catch {}
}

function renderSettings() {
  Object.keys(settings).forEach(key => {
    const input = document.querySelector('[data-setting="' + key + '"]');
    if (input) input.value = settings[key];
    const output = document.querySelector('[data-output="' + key + '"]');
    if (output) output.textContent = key === 'gain' || key === 'gate' ? settings[key] + ' dB' : key === 'release' ? settings[key] + ' ms' : key === 'bassGain' || key === 'midGain' || key === 'highGain' ? Number(settings[key]).toFixed(2) : Number(settings[key]).toFixed(2) + ' s';
  });
}

document.querySelectorAll('[data-setting]').forEach(input => input.addEventListener('input', () => {
  settings[input.dataset.setting] = Number(input.value);
  localStorage.setItem('i404.web.settings', JSON.stringify(settings));
  renderSettings();
}));

$('#listenButton').onclick = () => {
  if (started && paused) pauseGame(false);
  else if (capture && started) pauseGame(true);
  else if (capture) stopCapture();
  else playSong();
};
audio.addEventListener('ended', () => { if (capture) finishSong(); });
audio.addEventListener('error', () => { if (selected) status('AUDIO FILE COULD NOT BE DECODED · TRY MP3, M4A OR WAV'); });
$('#pauseButton').onclick = () => pauseGame(true);
$('#resumeButton').onclick = () => pauseGame(false);
$('#settingsButton').onclick = () => { $('#pauseOverlay').hidden = true; $('#settingsOverlay').hidden = false; };
$('#settingsDone').onclick = () => { $('#settingsOverlay').hidden = true; $('#pauseOverlay').hidden = false; };
$('#restartButton').onclick = restart;
$('#replayButton').onclick = restart;
$('#anotherSongButton').onclick = backToLibrary;
$('#libraryButton').onclick = backToLibrary;
$('#backButton').onclick = backToLibrary;
$('.brand').onclick = event => { if (!gameView.hidden) { event.preventDefault(); backToLibrary(); } };
$('#devButton').onclick = () => { if (dev) { dev = false; renderLibrary(); return; } $('#devPassword').value = ''; $('#devError').hidden = true; $('#devDialog').showModal(); };
$('#devSubmit').onclick = event => { event.preventDefault(); if ($('#devPassword').value === 'Bluel0tu$') { dev = true; $('#devDialog').close(); renderLibrary(); } else $('#devError').hidden = false; };
function editSong(song) { editing = song; $('#editTitle').value = song.title; $('#editArtist').value = song.artist; $('#editDialog').showModal(); }
$('#saveTrack').onclick = event => {
  event.preventDefault();
  if (!editing) return;
  Object.assign(editing, {title: $('#editTitle').value.trim(), artist: $('#editArtist').value.trim()});
  overrides[editing.id] = {title: editing.title, artist: editing.artist};
  localStorage.setItem('i404.web.songs', JSON.stringify(overrides));
  $('#editDialog').close();
  renderLibrary();
};
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', releaseInputs);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseInputs();
  else lastSceneProgressAt = performance.now();
});
renderSettings();
