// Rappels sans serveur : badge sur l'icône de l'application et rappel quotidien
// ajouté au Calendrier de l'appareil (qui envoie alors une vraie notification).

export function badgeSupported() {
  return 'setAppBadge' in navigator && 'Notification' in window;
}

export async function enableBadge() {
  if (!badgeSupported()) return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

export function updateBadge(count) {
  if (!badgeSupported() || Notification.permission !== 'granted') return;
  const p = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  p?.catch?.(() => {});
}

const pad = (n) => String(n).padStart(2, '0');

// Fichier .ics : un évènement quotidien de 10 minutes avec une alerte.
export function reminderIcs(time, appUrl) {
  const [h, m] = time.split(':').map(Number);
  const start = new Date();
  start.setDate(start.getDate() + (start.getHours() * 60 + start.getMinutes() >= h * 60 + m ? 1 : 0));
  const date = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Moto Flashcards//FR',
    'BEGIN:VEVENT',
    `UID:moto-rappel-quotidien-${date}@moto`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${date}T${pad(h)}${pad(m)}00`,
    'DURATION:PT10M',
    'RRULE:FREQ=DAILY',
    'SUMMARY:Réviser mes cartes (Moto)',
    `DESCRIPTION:Ouvrez Moto pour vos révisions du jour : ${appUrl}`,
    `URL:${appUrl}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Réviser mes cartes',
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export function downloadReminder(time) {
  const appUrl = new URL('./', location.href).href;
  const blob = new Blob([reminderIcs(time, appUrl)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rappel-moto.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
