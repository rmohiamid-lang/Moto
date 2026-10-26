// Planificateur de répétition espacée, proche de celui d'Anki.
// Deux algorithmes : FSRS (par défaut, celui des versions récentes d'Anki) et SM-2.
//
// État d'une carte :
//   state 0 = nouvelle      due = position dans la file des nouvelles
//   state 1 = apprentissage due = horodatage (ms)
//   state 2 = révision      due = numéro de jour
//   state 3 = réapprentissage due = horodatage (ms)
// ivl = intervalle en jours, ease = facteur de facilité SM-2 en ‰ (2500 = 250 %),
// step = étape courante d'apprentissage, s/d = stabilité/difficulté FSRS,
// lastReview = horodatage de la dernière réponse.

export const DEFAULT_SETTINGS = {
  algorithm: 'fsrs',        // 'fsrs' ou 'sm2'
  retention: 0.9,           // rétention visée par FSRS
  newPerDay: 20,
  reviewsPerDay: 200,
  learnSteps: [1, 10],      // minutes
  relearnSteps: [10],       // minutes
  graduatingIvl: 1,         // jours
  easyIvl: 4,               // jours
  startingEase: 2500,
  easyBonus: 1.3,
  hardFactor: 1.2,
  maxIvl: 36500,
  dayStartHour: 4,
  learnAheadMin: 20,
  theme: 'auto',
  gestures: true,
  autoTts: false,
  ttsLang: '',
  reminderTime: '19:00',
};

const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * MIN;

// Numéro du jour « Anki » local : la journée commence à dayStartHour.
export function dayNumber(ts, s) {
  const d = new Date(ts - s.dayStartHour * 60 * MIN);
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / DAY_MS);
}

export function dayStartTs(day, s) {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.dayStartHour).getTime();
}

function fuzz(ivl) {
  if (ivl < 3) return ivl;
  const delta = Math.max(1, Math.round(ivl * 0.05));
  return ivl + Math.floor(Math.random() * (2 * delta + 1)) - delta;
}

function clampIvl(ivl, s) {
  return Math.min(s.maxIvl, Math.max(1, Math.round(ivl)));
}

// --- FSRS (version 5, paramètres par défaut) ---------------------------------

const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5;
const FACTOR = 19 / 81;

const clampD = (d) => Math.min(10, Math.max(1, d));
const initD = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);

export function retrievability(elapsedDays, stability) {
  return (1 + FACTOR * elapsedDays / stability) ** DECAY;
}

function fsrsInterval(stability, s) {
  return clampIvl(stability / FACTOR * (s.retention ** (1 / DECAY) - 1), s);
}

// Stabilité et difficulté après la réponse `g` (1 à 4).
function fsrsMemory(card, g, now, s) {
  let S = card.s, D = card.d;
  if (S == null || D == null) {
    if (card.state !== 2) return { s: W[g - 1], d: initD(g) };
    // Carte venue de SM-2 : estimation à partir de l'intervalle et de la facilité.
    S = Math.max(1, card.ivl || 1);
    D = clampD(10 - ((card.ease || 2500) - 1300) * 9 / 1700);
  }
  const nextD = clampD(W[7] * initD(4) + (1 - W[7]) * (D - W[6] * (g - 3) * (10 - D) / 9));
  const last = card.lastReview;
  if (last && dayNumber(now, s) === dayNumber(last, s)) {
    // Plusieurs réponses le même jour (étapes d'apprentissage).
    return { s: Math.max(0.01, S * Math.exp(W[17] * (g - 3 + W[18]))), d: nextD };
  }
  const elapsed = last ? Math.max(0, (now - last) / DAY_MS) : S;
  const R = retrievability(elapsed, S);
  if (g === 1) {
    const forget = W[11] * D ** -W[12] * ((S + 1) ** W[13] - 1) * Math.exp(W[14] * (1 - R));
    return { s: Math.max(0.01, Math.min(forget, S)), d: nextD };
  }
  const bonus = g === 2 ? W[15] : g === 4 ? W[16] : 1;
  const recall = S * (Math.exp(W[8]) * (11 - D) * S ** -W[9] * (Math.exp(W[10] * (1 - R)) - 1) * bonus + 1);
  return { s: recall, d: nextD };
}

// --- Planification -------------------------------------------------------------

// Calcule l'issue d'une réponse (1 = À revoir, 2 = Difficile, 3 = Correct, 4 = Facile).
// Renvoie { state, due, ivl, ease, step, s, d, delayMs?, days? } sans modifier la carte.
export function schedule(card, rating, now, s, withFuzz = false) {
  const today = dayNumber(now, s);
  const fsrs = s.algorithm === 'fsrs';
  const mem = fsrs ? fsrsMemory(card, rating, now, s) : { s: card.s, d: card.d };
  const learning = card.state === 0 || card.state === 1;
  if (learning || card.state === 3) {
    const steps = (learning ? s.learnSteps : s.relearnSteps).filter((x) => x > 0);
    const step = card.state === 0 ? 0 : card.step;
    const base = { ease: card.ease || s.startingEase, ivl: card.ivl, s: mem.s, d: mem.d };
    const learnAt = (minutes, nextStep) => ({
      ...base, state: learning ? 1 : 3, step: nextStep,
      due: now + Math.round(minutes * MIN), delayMs: Math.round(minutes * MIN),
    });
    const graduate = (ivl) => {
      ivl = clampIvl(withFuzz ? fuzz(ivl) : ivl, s);
      return { ...base, state: 2, step: 0, ivl, due: today + ivl, days: ivl };
    };
    const relearnIvl = Math.max(1, card.ivl || 1);
    const gradIvl = (easy) => {
      if (fsrs) return fsrsInterval(mem.s, s);
      if (learning) return easy ? s.easyIvl : s.graduatingIvl;
      return easy ? relearnIvl + 1 : relearnIvl;
    };
    if (rating === 1) return steps.length ? learnAt(steps[0], 0) : graduate(gradIvl(false));
    if (rating === 2) {
      if (!steps.length) return graduate(gradIvl(false));
      const cur = steps[Math.min(step, steps.length - 1)];
      const delay = step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2
        : step === 0 ? Math.min(cur * 1.5, cur + 1440) : cur;
      return learnAt(delay, step);
    }
    if (rating === 3) {
      if (step + 1 < steps.length) return learnAt(steps[step + 1], step + 1);
      return graduate(gradIvl(false));
    }
    if (fsrs) {
      // « Facile » doit toujours donner plus que « Correct ».
      const good = fsrsInterval(fsrsMemory(card, 3, now, s).s, s);
      return graduate(Math.max(gradIvl(true), good + 1));
    }
    return graduate(gradIvl(true));
  }

  // Carte en révision.
  const ease = card.ease || s.startingEase;
  const delay = today - card.due; // négatif si révision en avance
  const ivl = Math.max(1, card.ivl);
  if (rating === 1) {
    const newEase = Math.max(1300, ease - 200);
    const steps = s.relearnSteps.filter((x) => x > 0);
    const newIvl = fsrs ? fsrsInterval(mem.s, s) : 1;
    if (!steps.length) {
      return { state: 2, step: 0, ivl: newIvl, ease: newEase, s: mem.s, d: mem.d, due: today + newIvl, days: newIvl, lapse: true };
    }
    return {
      state: 3, step: 0, ivl: newIvl, ease: newEase, s: mem.s, d: mem.d, lapse: true,
      due: now + Math.round(steps[0] * MIN), delayMs: Math.round(steps[0] * MIN),
    };
  }
  let hard, good, easy;
  if (fsrs) {
    [hard, good, easy] = [2, 3, 4].map((g) => fsrsInterval(fsrsMemory(card, g, now, s).s, s));
    hard = Math.min(hard, good);
    good = Math.max(good, hard + 1);
    easy = Math.max(easy, good + 1);
  } else {
    // En avance, on part du temps réellement écoulé depuis la dernière révision.
    const base = delay < 0 ? Math.max(1, ivl + delay) : ivl;
    const late = Math.max(0, delay);
    hard = clampIvl(Math.max(delay < 0 ? base : ivl + 1, base * s.hardFactor), s);
    good = clampIvl(Math.max(hard + 1, (base + late / 2) * ease / 1000), s);
    easy = clampIvl(Math.max(good + 1, (base + late) * ease / 1000 * s.easyBonus), s);
  }
  const [newIvl, newEase] = rating === 2 ? [hard, Math.max(1300, ease - 150)]
    : rating === 3 ? [good, ease] : [easy, ease + 150];
  const finalIvl = clampIvl(withFuzz ? fuzz(newIvl) : newIvl, s);
  return { state: 2, step: 0, ivl: finalIvl, ease: newEase, s: mem.s, d: mem.d, due: today + finalIvl, days: finalIvl };
}

export function answerCard(card, rating, now, s) {
  const r = schedule(card, rating, now, s, true);
  const out = {
    ...card,
    state: r.state, due: r.due, ivl: r.ivl, ease: r.ease, step: r.step,
    reps: (card.reps || 0) + 1,
    lapses: (card.lapses || 0) + (r.lapse ? 1 : 0),
    lastReview: now,
  };
  if (r.s != null) { out.s = r.s; out.d = r.d; }
  return out;
}

// Remet une carte à l'état « nouvelle ».
export function resetCard(card, position) {
  const out = { ...card, state: 0, due: position, ivl: 0, ease: 0, step: 0, reps: 0, lapses: 0 };
  delete out.s;
  delete out.d;
  delete out.lastReview;
  return out;
}

export function formatInterval(r) {
  if (r.delayMs !== undefined) {
    const m = r.delayMs / MIN;
    if (m < 1) return '< 1 min';
    if (m < 60) return `${Math.round(m)} min`;
    if (m < 1440) return `${fmt(m / 60)} h`;
    return `${fmt(m / 1440)} j`;
  }
  const d = r.days;
  if (d < 30) return `${d} j`;
  if (d < 365) return `${fmt(d / 30)} mois`;
  return `${fmt(d / 365)} an${d >= 730 ? 's' : ''}`;
}

function fmt(x) {
  return (Math.round(x * 10) / 10).toLocaleString('fr-FR');
}

// Cartes à étudier maintenant pour un ensemble de paquets.
// `take(card, kind)` applique les limites quotidiennes (kind = 'fresh' ou 'review').
export function buildQueues(cards, now, s, take = () => true) {
  const today = dayNumber(now, s);
  const learn = [], review = [], fresh = [];
  for (const c of cards) {
    if (c.suspended) continue;
    if (c.state === 1 || c.state === 3) learn.push(c);
    else if (c.state === 2 && c.due <= today) review.push(c);
    else if (c.state === 0) fresh.push(c);
  }
  learn.sort((a, b) => a.due - b.due);
  review.sort((a, b) => a.due - b.due || a.id - b.id);
  fresh.sort((a, b) => a.due - b.due || a.id - b.id);
  const learnNow = learn.filter((c) => c.due <= now);
  const learnToday = learn.filter((c) => c.due < dayStartTs(today + 1, s));
  return {
    learn, learnNow, learnToday,
    review: review.filter((c) => take(c, 'review')),
    fresh: fresh.filter((c) => take(c, 'fresh')),
  };
}

// Choisit la prochaine carte : apprentissage échu, puis révisions et nouvelles
// intercalées, puis apprentissage en avance (learnAheadMin).
export function pickNext(q, now, s, shown) {
  if (q.learnNow.length) return q.learnNow[0];
  const r = q.review.length, n = q.fresh.length;
  if (r && n) {
    // Répartit les nouvelles cartes régulièrement parmi les révisions.
    const ratio = (shown.fresh + 1) / (shown.review + 1);
    return ratio <= n / r ? q.fresh[0] : q.review[0];
  }
  if (r) return q.review[0];
  if (n) return q.fresh[0];
  const ahead = q.learn.find((c) => c.due <= now + s.learnAheadMin * MIN);
  return ahead || null;
}
