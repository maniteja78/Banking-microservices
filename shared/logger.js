// shared/logger.js
// Structured logger for Microservices with correlation ID and service tagging

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const SERVICE_COLORS = {
  'GATEWAY': COLORS.cyan,
  'AUTH-SVC': COLORS.green,
  'ACCOUNT-SVC': COLORS.blue,
  'TXN-SVC': COLORS.yellow,
  'NOTIF-SVC': COLORS.magenta,
  'FRAUD-SVC': COLORS.red,
  'EVENT-BUS': COLORS.bright + COLORS.gray
};

class Logger {
  constructor(serviceName) {
    this.serviceName = serviceName.toUpperCase();
    this.serviceColor = SERVICE_COLORS[this.serviceName] || COLORS.cyan;
  }

  _format(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const corrId = meta.correlationId ? ` [${meta.correlationId.slice(0, 8)}]` : '';
    const metaStr = Object.keys(meta).filter(k => k !== 'correlationId').length > 0 
      ? ' ' + JSON.stringify(meta) 
      : '';
    return `${COLORS.gray}${timestamp}${COLORS.reset} ${this.serviceColor}[${this.serviceName}]${COLORS.reset}${COLORS.dim}${corrId}${COLORS.reset} ${level} ${message}${metaStr}`;
  }

  info(message, meta = {}) {
    console.log(this._format(`${COLORS.green}INFO ${COLORS.reset}`, message, meta));
  }

  warn(message, meta = {}) {
    console.warn(this._format(`${COLORS.yellow}WARN ${COLORS.reset}`, message, meta));
  }

  error(message, meta = {}) {
    console.error(this._format(`${COLORS.red}ERROR${COLORS.reset}`, message, meta));
  }

  event(message, meta = {}) {
    console.log(this._format(`${COLORS.magenta}EVENT${COLORS.reset}`, message, meta));
  }
}

module.exports = Logger;
