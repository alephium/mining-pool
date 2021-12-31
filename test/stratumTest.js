const stratum = require('../lib/stratum');
const assert = require('assert');
const net = require('net');
const { expect } = require('chai');

var config = {
    banning: {
        enabled: true,
        time: 1,
        invalidPercent: 50,
        checkThreshold: 4,
        purgeInterval: 2
    },

    pool: {
        port: 38888,
        diff: 12
    },

    connectionTimeout: 5,
    maxConnectionsFromSameIP: 3
};

function DummyJob(){
    this.getJobParams = function(){
        return {
            jobId: 1,
            fromGroup: 0,
            toGroup: 0,
            headerBlob: 'headerBlob',
            txsBlob: 'txsBlob',
            targetBlob: 'targetBlob'
        }
    }
}

describe('test stratum server', function(){
    var server;
    this.beforeEach(function(){
        server = new stratum.Server(config);
    });

    this.afterEach(function(){
        server.close();
    });

    var submitMessage = {
        id: null,
        method: 'mining.submit',
        params: 'block'
    };

    function assertBanned(address){
        var [banned, _] = server.isBanned(address);
        assert(banned);
    }

    function assertNotBanned(address){
        var bannedIps = Object.keys(server.bannedIPs);
        assert(bannedIps.find(ip => ip === address) === undefined);
    }

    function setupClient(client, callback){
        client.setEncoding('utf8');
        client.setNoDelay(true);
        client.connect(config.pool.port);

        var buffer = '';
        client.on('data', function(data){
            buffer += data;
            if (buffer.indexOf('\n') !== -1){
                var messages = buffer.split('\n');
                var remain = buffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(message => {
                    if (message === '') return;
                    callback(JSON.parse(message));
                });
                buffer = remain;
            }
        });
    }

    it('should work as expected', function(done){
        var client = net.Socket();
        var jobs = [new DummyJob()];

        setupClient(client, function(message){
            switch(message.method) {
                case 'mining.set_difficulty':
                    expect(message.params).to.deep.equal([config.pool.diff]);
                    break;
                case 'mining.notify':
                    expect(message.params).to.deep.equal(jobs.map(job => job.getJobParams()));
                    break;
                case 'mining.submit_result':
                    expect(message.result).equal(true);
                    client.end();
                    done();
                    break;
                default:
                    assert(false, 'Unknow message type: ' + message.method);
            }
        });

        client.on('connect', function(){
            var clientIds = Object.keys(server.stratumClients);
            var stratumClient = server.stratumClients[clientIds[0]];
            stratumClient.on('submit', function(params, callback){
                expect(params).equal(submitMessage.params);
                callback(null, true);
            });

            assert(clientIds.length === 1);
            server.broadcastMiningJobs(jobs);
            client.write(JSON.stringify(submitMessage) + '\n');
        });
    })

    it('should disconnect if client is banned', function(done){
        var client = net.Socket();
        client.connect(config.pool.port);
        client.on('connect', function(){
            var remoteAddress = Object.keys(server.connectionNumFromIP)[0];
            server.addBannedIP(remoteAddress);
            assertBanned(remoteAddress);

            client.on('data', _ => {});
            client.end();
            client.on('close', function(){
                client.removeAllListeners('connect');
                client.removeAllListeners('close');

                server.on('client.disconnected', function(_client){
                    expect(remoteAddress).equal(_client.remoteAddress);
                    expect(Object.keys(server.stratumClients).length).equal(0);
                    expect(Object.keys(server.connectionNumFromIP).length).equal(0);
                    done();
                });
                client.connect(config.pool.port);
            });
        });
    })

    it('should ban client when received too much invalid shares', function(done){
        var client = net.Socket();
        client.connect(config.pool.port);
        client.on('connect', function(){
            var clientId = Object.keys(server.stratumClients)[0];
            var stratumClient = server.stratumClients[clientId];
            assertNotBanned(client.remoteAddress);

            for (var i = 0; i < config.banning.checkThreshold + 1; i++){
                client.write(JSON.stringify(submitMessage) + '\n');
            }

            stratumClient.on('submit', function(params, callback){
                expect(params).equal(submitMessage.params);
                callback(null, false);
            });
        });

        server.on('client.disconnected', function(stratumClient){
            assertBanned(stratumClient.remoteAddress);
            assert(Object.keys(server.stratumClients).length === 0);
            assert(Object.keys(server.connectionNumFromIP).length === 0);
            done();
        })
    })

    it('should reset shares', function(done){
        var client = net.Socket();
        client.connect(config.pool.port);

        var shares = [
            {id: null, method: 'mining.submit', params: {valid: true}},
            {id: null, method: 'mining.submit', params: {valid: true}},
            {id: null, method: 'mining.submit', params: {valid: true}},
            {id: null, method: 'mining.submit', params: {valid: false}},
        ];
        client.on('connect', function(){
            var clientId = Object.keys(server.stratumClients)[0];
            var stratumClient = server.stratumClients[clientId];
            assertNotBanned(client.remoteAddress);

            for (var idx in shares){
                client.write(JSON.stringify(shares[idx]) + '\n');
            }

            var invalids = 0, valids = 0;
            stratumClient.on('submit', function(params, callback){
                callback(null, params.valid);
                if (params.valid) valids++;
                else invalids++;
                if ((valids + invalids) === shares.length){
                    expect(stratumClient.shares.valid).equal(0);
                    expect(stratumClient.shares.invalid).equal(0);
                    done();
                } else {
                    expect(stratumClient.shares.valid).equal(valids);
                    expect(stratumClient.shares.invalid).equal(invalids);
                }
            });
        });
    })

    it('should unban client when ban time expired', function(done){
        var address = '11.11.11.11';
        server.addBannedIP(address);
        assertBanned(address);

        setTimeout(function() {
            assertNotBanned(address);
            done();
        }, (config.banning.purgeInterval + 1) * 1000);
    }).timeout((config.banning.purgeInterval + 2) * 1000);

    it('should not emit `forgaveBannedIP` if client has not been banned before', function(done){
        var client = net.Socket();
        client.connect(config.pool.port);

        client.on('connect', function(){
            var clientId = Object.keys(server.stratumClients)[0];
            var stratumClient = server.stratumClients[clientId];
            assertNotBanned(stratumClient.remoteAddress);

            setTimeout(_ => done(), 1000);
            stratumClient.on('forgaveBannedIP', function(){
                assert.fail('client has not been banned before');
            });
        });
    })

    it('should increase/decrease connection num when client connected/disconnected', function(){
        var ipAddress = '11.11.11.11';
        for (var idx = 0; idx < config.maxConnectionsFromSameIP; idx++){
            var okey = server.addConnectionFromIP(ipAddress);
            expect(okey).equal(true);
        }
        var okey = server.addConnectionFromIP(ipAddress);
        expect(okey).equal(false);

        server.removeConnectionFromIP(ipAddress);
        okey = server.addConnectionFromIP(ipAddress);
        expect(okey).equal(true);
    })

    it('should limit the connections from same IP', function(done){
        var clients = [];
        function createClient(num, callback){
            var client = net.Socket();
            client.connect(config.pool.port);
            clients.push(client);
            client.on('connect', _ => {
                if (num === 1) callback();
                else createClient(num - 1, callback);
            });
        }

        createClient(config.maxConnectionsFromSameIP, function(){
            var ipAddress = Object.keys(server.connectionNumFromIP)[0];
            var connectionNum = server.connectionNumFromIP[ipAddress];
            if (connectionNum && connectionNum == config.maxConnectionsFromSameIP){
                var client = net.Socket();
                client.connect(config.pool.port);
                client.on('close', function(){
                    clients.forEach(c => c.destroy());
                    done();
                });
            }
        });
    })
})
