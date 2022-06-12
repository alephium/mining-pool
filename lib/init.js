const Pool = require("./pool");
const winston = require('winston');
const bignum = require('bignum');
require('winston-daily-rotate-file');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = process.env.CONFIG_FILE || path.resolve(__dirname, 'config.json');

if (!fs.existsSync(CONFIG_FILE)){
    console.log(`${CONFIG_FILE} does not exist.`);
    process.exit(1);
}

var config = JSON.parse(fs.readFileSync(CONFIG_FILE, {encoding: 'utf8'}));
if ((config.withholdPercent < 0) || (config.withholdPercent >= 1)){
    console.log('invalid withhold percent');
    process.exit(1);
}

if (config.confirmationTime < 30600) {
    console.warn("\x1b[31m`confirmationTime` less than 30600, please make sure that the pool wallet has enough balance to pay the rewards\x1b[0m")
}

if (config.withholdPercent === 0){
    console.warn("\x1b[31m`withholdPercent` is 0, please make sure that the pool wallet has enough balance to pay the transaction fee\x1b[0m")
}

if (!config.daemon.apiKey || config.daemon.apiKey === '') {
    console.warn("\x1b[31m`apiKey` is not configured, please make sure you don't need an apiKey to access your full node\x1b[0m")
}

global.diff1Target = bignum.pow(2, 256 - config.diff1TargetNumZero).sub(1);

var logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(i => `${i.timestamp} | ${i.level} | ${i.message}`)
    ),
    transports: [
        new winston.transports.DailyRotateFile({
            filename: config.logPath + 'pool-%DATE%-debug.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '100m',
            maxFiles: '5d',
            level: 'debug'
        }),
        new winston.transports.DailyRotateFile({
            filename: config.logPath + 'pool-%DATE%-info.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '100m',
            maxFiles: '5d',
            level: 'info'
        }),
        new winston.transports.DailyRotateFile({
            filename: config.logPath + 'pool-%DATE%-error.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '100m',
            maxFiles: '5d',
            level: 'error'
        }),
        new winston.transports.Console({
            level: 'info'
        })
    ]
});

var pool = new Pool(config, logger);
pool.start();
