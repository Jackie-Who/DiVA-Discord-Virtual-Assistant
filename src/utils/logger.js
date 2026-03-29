const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = LEVELS.info;

function setLevel(level) {
    if (LEVELS[level] !== undefined) {
        currentLevel = LEVELS[level];
    }
}

function formatTimestamp() {
    return new Date().toISOString();
}

function log(level, message, data) {
    if (LEVELS[level] < currentLevel) return;

    const entry = {
        timestamp: formatTimestamp(),
        level,
        message,
        ...(data && { data })
    };

    const output = JSON.stringify(entry);

    if (level === 'error') {
        console.error(output);
    } else if (level === 'warn') {
        console.warn(output);
    } else {
        console.log(output);
    }
}

const logger = {
    setLevel,
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
};

export default logger;
