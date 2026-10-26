// Lecture des cartes à voix haute avec la synthèse vocale de l'appareil.

const supported = 'speechSynthesis' in window;

export const TTS_LANGUAGES = [
  ['', 'Langue de l’appareil'], ['fr-FR', 'Français'], ['en-US', 'Anglais (États-Unis)'],
  ['en-GB', 'Anglais (Royaume-Uni)'], ['es-ES', 'Espagnol'], ['de-DE', 'Allemand'],
  ['it-IT', 'Italien'], ['pt-PT', 'Portugais'], ['pt-BR', 'Portugais (Brésil)'],
  ['nl-NL', 'Néerlandais'], ['ar-SA', 'Arabe'], ['tr-TR', 'Turc'], ['ru-RU', 'Russe'],
  ['zh-CN', 'Chinois'], ['ja-JP', 'Japonais'], ['ko-KR', 'Coréen'],
];

export function ttsAvailable() {
  return supported;
}

// Texte à lire pour une face de carte : le texte des balises tts s'il y en a,
// sinon le texte visible (pour la réponse : seulement ce qui suit la question).
export function ttsSegments(html, side, defaultLang) {
  let part = html;
  if (side === 'a') {
    const split = html.split(/<hr[^>]*id=["']?answer["']?[^>]*>/i);
    if (split.length > 1) part = split[split.length - 1];
  }
  const doc = new DOMParser().parseFromString(part, 'text/html');
  const tagged = [...doc.querySelectorAll('[data-tts-lang]')];
  if (tagged.length) {
    return tagged.map((el) => ({ text: clean(el), lang: el.dataset.ttsLang })).filter((x) => x.text);
  }
  for (const el of doc.querySelectorAll('script, style, .replay-button, details.hint, input')) el.remove();
  if (side === 'a' && part === html) {
    // Texte à trous sans séparateur : on lit seulement les réponses.
    const clozes = [...doc.querySelectorAll('.cloze')];
    if (clozes.length) return [{ text: clozes.map(clean).join(', '), lang: defaultLang }];
  }
  for (const el of doc.querySelectorAll('.cloze')) {
    if (/^\[.*\]$/.test(el.textContent.trim())) el.textContent = ' … ';
  }
  const text = clean(doc.body);
  return text ? [{ text, lang: defaultLang }] : [];
}

function clean(el) {
  for (const br of el.querySelectorAll?.('br, div, p, li') || []) br.append(' ');
  return el.textContent.replace(/\s+/g, ' ').trim();
}

// Garde une référence aux phrases en cours : sinon Safari peut les libérer et
// couper la lecture.
let utterances = [];

// Renvoie false s'il n'y a rien à lire. onError(message) est appelé si la voix échoue.
export function speak(segments, onError = () => {}) {
  if (!supported || !segments.length) return false;
  const synth = speechSynthesis;
  // Sur iPad, un speak() juste après cancel() est souvent ignoré : on n'arrête que
  // ce qui est réellement en cours, et on attend un instant avant de relancer.
  const busy = synth.speaking || synth.pending;
  if (busy) synth.cancel();
  if (synth.paused) synth.resume();
  const voices = synth.getVoices();
  utterances = segments.map(({ text, lang }) => {
    const u = new SpeechSynthesisUtterance(text);
    if (lang) {
      u.lang = lang;
      const voice = voices.find((v) => v.lang.replace('_', '-') === lang)
        || voices.find((v) => v.lang.startsWith(lang.split('-')[0]));
      if (voice) u.voice = voice;
    }
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') onError(e.error || 'erreur inconnue');
    };
    return u;
  });
  const start = () => { for (const u of utterances) synth.speak(u); };
  if (busy) setTimeout(start, 120); else start();
  return true;
}

export function stopSpeaking() {
  if (supported && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
}

// Sur iPad, la première lecture doit venir d'un toucher : on « déverrouille » la
// voix au premier toucher pour que la lecture automatique fonctionne ensuite.
export function unlockOnFirstTouch() {
  if (!supported) return;
  const unlock = () => {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  };
  document.addEventListener('pointerup', unlock, { once: true, capture: true });
}
