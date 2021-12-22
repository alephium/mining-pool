const winston = require('winston');

exports.logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(i => `${i.timestamp} | ${i.level} | ${i.message}`)
    ),
    transports: new winston.transports.Console({
        level: 'debug'
    })
});

exports.config = {
    "daemon": {
        "host": "127.0.0.1",
        "port": 12973,
        "apiKey": "0000000000000000000000000000000000000000000000000000000000000000",
        "minerApiPort": 10973
    },

    "redis": {
        "host": "127.0.0.1",
        "port": 6379
    },

    "diff1TargetNumZero": 30,
    "withholdPercent": 0,
    "rewardInterval": 600,
    "confirmationTime": 30600,

    "minPaymentCoins": "3.5",
    "paymentInterval": 600,

    "addresses": [],

    "wallet": {
        "name": "",
        "password": "",
        "mnemonicPassphrase": ""
    }
};
