// Lines that do not parse are skipped, so one bad line never hides a device's other events.
export function parseEvents(text, device) {
  const events = [];
  for (const line of text.split('\n')) {
    const event = parseLine(line);
    if (event) events.push({ ...event, device });
  }
  return events;
}

function parseLine(line) {
  if (!line.trim()) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const ok = typeof event?.id === 'string' && typeof event.type === 'string' && !Number.isNaN(Date.parse(event.time));
  return ok ? event : null;
}
