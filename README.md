## Build



1. [install redis](https://redis.io/topics/quickstart)
    > ubuntu ``` sudo apt install redis-server```
    
2. [install alephium full node](https://wiki.alephium.org/Full-Node-Starter-Guide.html)
   > be sure to specify in user.conf (see the instructions [Configure Miner Addresses section](https://wiki.alephium.org/GPU-Miner-Guide.html#configure-miner-addresses)) 
   > the mining addresses that you will use in [config.json](https://github.com/alephium/mining-pool/blob/master/config.json)  of the pool. they must match
3. install node.js(>=14) and npm(>=8)
   > install nvm '''wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.37.2/install.sh | bash'''
   > at this point there will be a problem, the system does not see that nvm is installed. you can use '''[[ -s $HOME/.nvm/nvm.sh ]] && . $HOME/.nvm/nvm.sh'''
   > now install node.js ```nvm install 14.15``` and 
   > update npm ``` npm install -g npm```

4.wait until your node is fully synchronized, then you need to log in to your miner wallet (whose address you specified in user.conf and config.json).
   > 
   ```sh
   curl -X 'PUT' \
  'http://127.0.0.1:12973/wallets' \
  -H 'accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'X-API-KEY: '\
  -d '{
  "password": "",
  "mnemonic": "",
  "walletName": "",
  "isMiner": true

}'
```

## now you are ready to install

1. git clone https://github.com/alephium/mining-pool.git
2. go to the mining-pool folder ```cd mining-pool```
3. edit the config.json file
    > change these lines
     ```javascript
     "addresses": [],                 // 4 addresses(we have 4 groups) to where block rewards are given

    "wallet": {
        "name": "",                  // wallet name
        "password": ""              // wallet password
        
    ```
    be careful - the addresses are user.conf and config.json must match, use the name and password that you used to log into the wallet on the node
4. ```npm install```
5.  ```npm run start```

## Run

configs explanation:

```javascript
{
    "logPath": "./logs/",            // log path

    "connectionTimeout": 600,        // disconnect workers that haven't submitted shares for this many seconds

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
    "rewardInterval": 600,           // update miner balances every this many seconds
    "confirmationTime": 30600,       // 510m by default, you can decrease this if your payment addresses have enough balance

    "minPaymentCoins": "3.5",        // minimum number of coins that a miner must earn before sending payment
    "paymentInterval": 600,          // send payment every this many seconds

    "addresses": [],                 // 4 addresses(we have 4 groups) to where block rewards are given

    "wallet": {
        "name": "",                  // wallet name
        "password": ""              // wallet password
        
    }
}
```



