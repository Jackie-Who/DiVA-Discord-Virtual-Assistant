/**
 * Timezone helpers (no external deps — uses Node's built-in Intl + Date).
 *
 * The tricky problem: given a local-time string like "2026-04-26 09:00" in
 * IANA zone "America/Los_Angeles", what is the UTC instant?
 *
 * Approach: round-trip via Intl.DateTimeFormat to discover the offset for
 * that local time in that zone, then subtract the offset.
 */

/**
 * Validate an IANA timezone string.
 */
export function isValidIANAZone(zone) {
    if (typeof zone !== 'string' || !zone) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

/**
 * Parse "YYYY-MM-DD HH:MM" (or "YYYY-MM-DDTHH:MM") in `zone` and return
 * a Date representing the UTC instant.
 *
 * Throws on malformed input.
 */
export function localToUtc(localStr, zone) {
    if (!isValidIANAZone(zone)) {
        throw new Error(`Invalid timezone: ${zone}`);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localStr.trim());
    if (!m) throw new Error(`Local time must be "YYYY-MM-DD HH:MM" (got "${localStr}")`);

    const [, year, month, day, hour, minute, second] = m.map(Number);

    // Step 1: assume UTC, build the date
    const fakeUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));

    // Step 2: project this UTC instant into the target zone — read the wall clock
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(fakeUtc);
    const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);

    // The wall clock in the zone reads tzWall; we wanted it to read (year, month, ...).
    // The difference (in ms) between what we got and what we wanted is the zone offset.
    const tzWallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'),
                                  get('hour') === 24 ? 0 : get('hour'),
                                  get('minute'), get('second'));
    const offsetMs = tzWallAsUtc - fakeUtc.getTime();

    // Step 3: actual UTC instant = fake UTC - offset
    return new Date(fakeUtc.getTime() - offsetMs);
}

/**
 * Format a Date as a SQLite-friendly UTC string: "YYYY-MM-DD HH:MM:SS".
 * (SQLite's datetime() uses this format — matches stored fire_at_utc values.)
 */
export function toSqliteUtc(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/**
 * Format a UTC Date as a human-readable string in the given zone.
 * e.g. "Sun, Apr 26, 9:00 AM PDT"
 */
export function formatLocal(date, zone, opts = {}) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
        ...opts,
    }).format(date);
}

/**
 * "Now" in a given IANA zone, returned as { year, month, day, hour, minute, weekday }.
 * Useful for the system prompt + scheduler.
 */
export function nowInZone(zone) {
    if (!isValidIANAZone(zone)) zone = 'UTC';
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t)?.value;
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: parseInt(get('year'), 10),
        month: parseInt(get('month'), 10),
        day: parseInt(get('day'), 10),
        hour: parseInt(get('hour'), 10),
        minute: parseInt(get('minute'), 10),
        weekday: weekdayMap[get('weekday')] ?? 0,
    };
}
