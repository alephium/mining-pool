## Build

1. install redis
2. install alephium full node
3. install node.js(>=14) and npm(>=8)

## Run

configs explanation:

```javascript
{
    "logPath": "./logs/",            // log path

    "connectionTimeout": 600,        // disconnect workers that haven't submitted shares for this many seconds
    "maxConnectionsFromSameIP": 10,  // limit number of connection from same IP address
    "whitelistIps": [],		     // whitelist IP address from 'maxConnectionsFromSameIP'
	
    "jobExpiryPeriod": 10,           // job expires after set period
	
    "banning": {
        "enabled": true,             // enabled by default
        "time": 600,                 // how many seconds to ban worker for
        "invalidPercent": 50,        // what percent of invalid shares triggers ban
        "checkThreshold": 500,       // perform check when this many shares have been submitted
        "purgeInterval": 300         // every this many seconds clear out the list of old bans
    },

    "diff1TargetNumZero": 30,        // diff1 target leading zero num
    "pool": {
        "port": 20032,               // port which the server bind
        "diff": 64,                  // init difficulty

        "varDiff": {
            "minDiff": 16,           // minimum difficulty
            "maxDiff": 4096,         // maximum difficulty
            "targetTime": 15,        // try to get 1 share per this many seconds
            "retargetTime": 90,      // check to see if we should retarget every this many seconds
            "variancePercent": 30    // allow time to very this % from target without retargeting
        }
    },

    "daemon": {
        "host": "127.0.0.1",         // alephium full node host
        "port": 12973,               // alephium full node rest api port
        "apiKey": "xxx",             // alephium full node api key
        "minerApiPort": 10973        // alephium full node miner api port
    },

    "redis": {
        "host": "127.0.0.1",         // redis host
        "port": 6379                 // redis port
    },

    "withholdPercent": 0.005,        // coinbase reward withhold percent(0.5% by default), used for tx fee mainly
    "rewardEnabled": true,           // enabled by default
    "rewardInterval": 600,           // update miner balances every this many seconds
    "confirmationTime": 30600,       // 510m by default, you can decrease this if your payment addresses have enough balance

    "paymentEnabled": true,          // enabled by default
    "minPaymentCoins": "3.5",        // minimum number of coins that a miner must earn before sending payment
    "paymentInterval": 600,          // send payment every this many seconds
    "txConfirmations": {             // Check tx confirmations to remove/pay back balance after tx
        "chainConfirmations": 10,
        "fromGroupConfirmations": 5,
        "toGroupConfirmations": 5
    },

    "persistence": {		     // persistent shares and blocks
        "enabled": false,	     // disabled by default
        "host": "127.0.0.1",	     // postgresql ip
        "port": 5432,		     // postgresql port
        "user": "postgres",	     // postgresql user
        "password": "postgres",	     // postgresql password
        "database": "mining-pool"    // database name
    },
	
    "addresses": [],                 // 4 addresses(we have 4 groups) to where block rewards are given

    "wallet": {
        "name": "",                  // wallet name
        "password": "",              // wallet password
        "mnemonicPassphrase": ""     // wallet mnemonic passphrase
    }
}
```

run:

```shell
npm install
npm run start
```

