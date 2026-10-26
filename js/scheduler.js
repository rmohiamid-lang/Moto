// Planificateur de type SM-2, proche de celui d'Anki.
//
// État d'une carte :
//   state 0 = nouvelle      due = position dans la file des nouvelles
//   state 1 = apprentissage due = horodatage (ms)
//   state 2 = révision      due = numéro de jour
//   state 3 = réapprentissage due = horodatage (ms)
// ivl = intervalle en jours, ease = facteur de facilité en ‰ (2500 = 250 %),
// step = étape courante d'apprentissage.

export const DEFAULT_SETTINGS = {
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

// Calcule l'issue d'une réponse (1 = À revoir, 2 = Difficile, 3 = Correct, 4 = Facile).
// Renvoie { state, due, ivl, ease, step, delayMs?, days? } sans modifier la carte.
export function schedule(card, rating, now, s, withFuzz = false) {
  const today = dayNumber(now, s);
  const learning = card.state === 0 || card.state === 1;
  if (learning || card.state === 3) {
    const steps = (learning ? s.learnSteps : s.relearnSteps).filter((x) => x > 0);
    const step = card.state === 0 ? 0 : card.step;
    const base = { ease: card.ease || s.startingEase, ivl: card.ivl };
    const learnAt = (minutes, nextStep) => ({
      ...base, state: learning ? 1 : 3, step: nextStep,
      due: now + Math.round(minutes * MIN), delayMs: Math.round(minutes * MIN),
    });
    const graduate = (ivl) => {
      ivl = clampIvl(withFuzz ? fuzz(ivl) : ivl, s);
      return { ...base, state: 2, step: 0, ivl, due: today + ivl, days: ivl };
    };
    const relearnIvl = Math.max(1, card.ivl || 1);
    if (rating === 1) return steps.length ? learnAt(steps[0], 0) : graduate(learning ? s.graduatingIvl : relearnIvl);
    if (rating === 2) {
      if (!steps.length) return graduate(learning ? s.graduatingIvl : relearnIvl);
      const cur = steps[Math.min(step, steps.length - 1)];
      const delay = step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2
        : step === 0 ? Math.min(cur * 1.5, cur + 1440) : cur;
      return learnAt(delay, step);
    }
    if (rating === 3) {
      if (step + 1 < steps.length) return learnAt(steps[step + 1], step + 1);
      return graduate(learning ? s.graduatingIvl : relearnIvl);
    }
    return graduate(learning ? s.easyIvl : relearnIvl + 1);
  }

  // Carte en révision.
  const ease = card.ease || s.startingEase;
  const delay = Math.max(0, today - card.due);
  const ivl = Math.max(1, card.ivl);
  if (rating === 1) {
    const newIvl = 1;
    const newEase = Math.max(1300, ease - 200);
    const steps = s.relearnSteps.filter((x) => x > 0);
    if (!steps.length) return { state: 2, step: 0, ivl: newIvl, ease: newEase, due: today + 1, days: 1, lapse: true };
    return {
      state: 3, step: 0, ivl: newIvl, ease: newEase, lapse: true,
      due: now + Math.round(steps[0] * MIN), delayMs: Math.round(steps[0] * MIN),
    };
  }
  const hard = clampIvl(Math.max(ivl + 1, ivl * s.hardFactor), s);
  const good = clampIvl(Math.max(hard + 1, (ivl + delay / 2) * ease / 1000), s);
  const easy = clampIvl(Math.max(good + 1, (ivl + delay) * ease / 1000 * s.easyBonus), s);
  const [newIvl, newEase] = rating === 2 ? [hard, Math.max(1300, ease - 150)]
    : rating === 3 ? [good, ease] : [easy, ease + 150];
  const finalIvl = clampIvl(withFuzz ? fuzz(newIvl) : newIvl, s);
  return { state: 2, step: 0, ivl: finalIvl, ease: newEase, due: today + finalIvl, days: finalIvl };
}

export function answerCard(card, rating, now, s) {
  const r = schedule(card, rating, now, s, true);
  return {
    ...card,
    state: r.state, due: r.due, ivl: r.ivl, ease: r.ease, step: r.step,
    reps: (card.reps || 0) + 1,
    lapses: (card.lapses || 0) + (r.lapse ? 1 : 0),
  };
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
// Renvoie { learn, review, fresh } (listes triées) et les compteurs à afficher.
export function buildQueues(cards, now, s, limits) {
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
  const reviewLimited = review.slice(0, Math.max(0, limits.reviews));
  const freshLimited = fresh.slice(0, Math.max(0, limits.fresh));
  const learnNow = learn.filter((c) => c.due <= now);
  const learnToday = learn.filter((c) => c.due < dayStartTs(today + 1, s));
  return { learn, learnNow, learnToday, review: reviewLimited, fresh: freshLimited };
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
