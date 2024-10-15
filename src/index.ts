import WebSocket from 'ws';
import {
    DpApi,
    EndpointApi,
    ExitNode,
    NodeApi,
    Payload,
    Request,
    Response,
    Result as Res,
    Segment,
    SegmentCache,
    Utils,
} from '@hoprnet/uhttp-lib';

import * as DB from './db';
import * as RequestStore from './request-store';
import * as ResponseSegmentStore from './response-segment-store';
import Version from './version';
import log from './logger';

// WebSocket heartbeats
const HeartBeatInterval = 30e3; // 30 sec
// Hoprd nodes version to be considered as valid relays
const RelayNodesCompatVersions = ['2.1', '2.2'];
// Removing segments from incomplete requests after this grace period
const RequestPurgeTimeout = 60e3; // 60 sec
// base interval for checking relays
const SetupRelayPeriod = 1e3 * 60 * 15; // 15 min
// reconnect timeout for the websocket after closure
const SocketReconnectTimeout = 3e3; // 3 sec
// Time period in which counters for crypto are considered valid
const ValidCounterPeriod = 1e3 * 60 * 60; // 1 hour
// Time period to keep segments for potential retransfer
const ValidResponseSegmentPeriod = 1e3 * 60 * 10; // 10 min

type State = {
    socket?: WebSocket;
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    peerId: string;
    cache: SegmentCache.Cache;
    deleteTimer: Map<string, ReturnType<typeof setTimeout>>; // deletion timer of requests in segment cache
    db: DB.DB;
    relays: string[];
    heartbeatInterval?: ReturnType<typeof setInterval>;
};

type OpsDP = {
    endpoint: string;
    nodeAccessToken: string;
};

type Ops = {
    privateKey: string;
    publicKey: string;
    apiEndpoint: URL;
    accessToken: string;
    discoveryPlatform?: OpsDP;
    dbFile: string;
};

type Msg = {
    type: string;
    tag: number;
    body: string;
};

async function start(ops: Ops) {
    try {
        const state = await setup(ops);
        setupSocket(state, ops);
        removeExpiredRequests(state);
        removeExpiredSegmentResponses(state);
        setupRelays(state, ops);
    } catch (err) {
        log.error(
            'error initializing %s: %o',
            ExitNode.prettyPrint('____', Version, Date.now(), []),
            err,
        );
        process.exit(1);
    }
}

async function setup(ops: Ops): Promise<State> {
    const db = await DB.setup(ops.dbFile).catch((err) => {
        log.error('error setting up database: %o', err);
    });
    if (!db) {
        throw new Error('No database');
    }

    await RequestStore.setup(db);
    await ResponseSegmentStore.setup(db);

    log.verbose('set up DB at', ops.dbFile);

    const resPeerId = await NodeApi.accountAddresses(ops).catch((err: Error) => {
        log.error('error fetching account addresses: %o', err);
    });
    if (!resPeerId) {
        throw new Error('No peerId');
    }

    const { hopr: peerId } = resPeerId;
    const cache = SegmentCache.init();
    const deleteTimer = new Map();

    const logOpts: Record<string, string> = {
        publicKey: ops.publicKey,
        apiEndpoint: ops.apiEndpoint.href,
    };
    if (ops.discoveryPlatform) {
        logOpts.discoveryPlatformEndpoint = ops.discoveryPlatform.endpoint;
    }
    log.info('%s started with %o', ExitNode.prettyPrint(peerId, Version, Date.now(), []), logOpts);

    return {
        cache,
        deleteTimer,
        privateKey: Utils.hexStringToBytes(ops.privateKey),
        publicKey: Utils.hexStringToBytes(ops.publicKey),
        peerId,
        db,
        relays: [],
    };
}

function setupSocket(state: State, ops: Ops) {
    const socket = connectWS(ops);
    if (!socket) {
        log.error('error opening websocket');
        process.exit(3);
    }

    socket.onmessage = onMessage(state, ops);

    socket.on('error', (err: Error) => {
        log.error('error on socket: %o', err);
        socket.onmessage = null;
        socket.close();
    });

    socket.on('close', (evt: WebSocket.CloseEvent) => {
        log.warn('closing socket %o - attempting reconnect', evt);
        clearInterval(state.heartbeatInterval);
        // attempt reconnect
        setTimeout(() => setupSocket(state, ops), SocketReconnectTimeout);
    });

    socket.on('open', () => {
        log.verbose('opened websocket listener');
        clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = setInterval(() => {
            socket.ping((err?: Error) => {
                if (err) {
                    log.error('error on ping: %o', err);
                }
            });
        }, HeartBeatInterval);
    });

    state.socket = socket;
}

function removeExpiredSegmentResponses(state: State) {
    ResponseSegmentStore.removeExpired(state.db, Date.now() - ValidResponseSegmentPeriod)
        .then(() => {
            log.info('successfully removed expired response segments from db');
        })
        .catch((err) => {
            log.error('error during removeExpiredSegmentResponses: %o', err);
        })
        .finally(() => {
            scheduleRemoveExpiredSegmentResponses(state);
        });
}

function removeExpiredRequests(state: State) {
    RequestStore.removeExpired(state.db, Date.now() - ValidCounterPeriod)
        .then(() => {
            log.info('successfully removed expired requests from db');
        })
        .catch((err) => {
            log.error('error during removeExpiredRequests: %o', err);
        })
        .finally(() => {
            scheduleRemoveExpiredRequests(state);
        });
}

function scheduleRemoveExpiredSegmentResponses(state: State) {
    setTimeout(function () {
        removeExpiredSegmentResponses(state);
    }, ValidResponseSegmentPeriod);
}

function scheduleRemoveExpiredRequests(state: State) {
    // schedule next run somehwere between 1h and 1h and 10m
    const next = ValidCounterPeriod + Math.floor(Math.random() * 10 * 60e3);
    const logH = Math.floor(next / 1000 / 60 / 60);
    const logM = Math.round(next / 1000 / 60) - logH * 60;

    log.info('scheduling next remove expired requests in %dh%dm', logH, logM);
    setTimeout(() => removeExpiredRequests(state), next);
}

async function setupRelays(state: State, ops: Ops) {
    try {
        const resPeers = await NodeApi.getPeers(ops);
        if (NodeApi.isError(resPeers)) {
            throw new Error(`node internal: ${JSON.stringify(resPeers)}`);
        }

        // available peers
        const relays = resPeers.connected
            .filter(({ reportedVersion }) =>
                RelayNodesCompatVersions.some((v) => reportedVersion.startsWith(v)),
            )
            .map(({ peerId, peerAddress }) => ({ peerId, peerAddress }));

        const resChannels = await NodeApi.getNodeChannels(ops);

        // open channels
        const openChannelsArr = resChannels.outgoing
            .filter(({ status }) => status === 'Open')
            .map(({ peerAddress }) => peerAddress);
        const openChannels = new Set(openChannelsArr);

        state.relays = relays
            .filter(({ peerAddress }) => openChannels.has(peerAddress))
            .map(({ peerId }) => peerId);

        log.info('found %d potential relays', state.relays.length);
    } catch (err) {
        log.error('error during relay setup: %o', err);
    } finally {
        setTimeout(() => scheduleSetupRelays(state, ops));
    }
}

function scheduleSetupRelays(state: State, ops: Ops) {
    // schdule next run somehwere between 15min and 20min
    const next = SetupRelayPeriod + Math.floor(Math.random() * 5 * 60e3);
    const logM = Math.floor(next / 1000 / 60);
    const logS = Math.round(next / 1000) - logM * 60;

    log.info('scheduling next setup relays in %dm%ds', logM, logS);
    setTimeout(() => setupRelays(state, ops), next);
}

function onMessage(state: State, ops: Ops) {
    return function (evt: WebSocket.MessageEvent) {
        const recvAt = performance.now();
        const raw = evt.data.toString();
        const msg = JSON.parse(raw) as Msg;

        if (msg.type !== 'message') {
            return;
        }

        // determine if ping req
        if (msg.body.startsWith('ping-')) {
            return onPingReq(state, ops, msg);
        }

        // determine if info req
        if (msg.body.startsWith('info-')) {
            return onInfoReq(state, ops, msg);
        }

        // determine if segment retransfer
        if (msg.body.startsWith('resg-')) {
            return onRetransferSegmentsReq(state, ops, msg);
        }

        // determine if valid segment
        const segRes = Segment.fromMessage(msg.body);
        if (Res.isErr(segRes)) {
            log.info('cannot create segment:', segRes.error);
            return;
        }

        const segment = segRes.res;
        const cacheRes = SegmentCache.incoming(state.cache, segment);
        switch (cacheRes.res) {
            case 'complete':
                log.verbose('completing segment:', Segment.prettyPrint(segment));
                clearTimeout(state.deleteTimer.get(segment.requestId));
                completeSegmentsEntry(
                    state,
                    ops,
                    cacheRes.entry as SegmentCache.Entry,
                    msg.tag,
                    recvAt,
                );
                break;
            case 'error':
                log.error('error caching segment:', cacheRes.reason);
                break;
            case 'already-cached':
                log.info('already cached:', Segment.prettyPrint(segment));
                break;
            case 'added-to-request':
                log.verbose(
                    'inserted new segment to existing request:',
                    Segment.prettyPrint(segment),
                );
                break;
            case 'inserted-new':
                log.verbose('inserted new first segment:', Segment.prettyPrint(segment));
                state.deleteTimer.set(
                    segment.requestId,
                    setTimeout(() => {
                        log.info('purging incomplete request:', segment.requestId);
                        SegmentCache.remove(state.cache, segment.requestId);
                    }, RequestPurgeTimeout),
                );
                break;
        }
    };
}

function onPingReq(state: State, ops: Ops, msg: Msg) {
    log.info('received ping req:', msg.body);
    // ping-originPeerId
    const [, recipient] = msg.body.split('-');
    const conn = { ...ops, hops: 0 };
    NodeApi.sendMessage(conn, {
        recipient,
        tag: msg.tag,
        message: `pong-${state.peerId}`,
    }).catch((err) => {
        log.error('error sending pong: %o', err);
    });
}

function onInfoReq(state: State, ops: Ops, msg: Msg) {
    log.info('received info req:', msg.body);
    // info-originPeerId-hops-manualRelay
    const [, recipient, hopsStr, reqRel] = msg.body.split('-');
    const hops = parseInt(hopsStr, 10);
    const conn = { ...ops, hops };
    const relayShortIds =
        reqRel === 'r' ? state.relays.map((rId) => Utils.shortPeerId(rId).substring(1)) : undefined;
    const info = {
        peerId: state.peerId,
        counter: Date.now(),
        version: Version,
        relayShortIds,
    };
    const res = Payload.encodeInfo(info);
    if (Res.isErr(res)) {
        log.error('error encoding info:', res.error);
        return;
    }
    const message = `nfrp-${res.res}`;
    NodeApi.sendMessage(conn, {
        recipient,
        tag: msg.tag,
        message,
    }).catch((err) => {
        log.error('error sending info: %o', err);
    });
}

function onRetransferSegmentsReq(state: State, ops: Ops, msg: Msg) {
    log.info('received retransfer segments req:', msg.body);
    // resg-originPeerId-hops-requestId-segmentNrs
    const [, recipient, hopsStr, requestId, rawSegNrs] = msg.body.split('-');
    const hops = parseInt(hopsStr, 10);
    const conn = { ...ops, hops };
    const segNrs = rawSegNrs.split(',').map(parseInt);

    ResponseSegmentStore.all(state.db, requestId, segNrs)
        .then((segments) => {
            segments.map((seg, idx) => {
                setTimeout(() => {
                    NodeApi.sendMessage(conn, {
                        recipient,
                        tag: msg.tag,
                        message: Segment.toMessage(seg),
                    }).catch((err: Error) => {
                        log.error('error retransferring %s: %o', Segment.prettyPrint(seg), err);
                    });
                }, idx);
            });
        })
        .catch((err) => {
            log.error('error reading response segments: %o', err);
        });
}

async function completeSegmentsEntry(
    state: State,
    ops: Ops,
    cacheEntry: SegmentCache.Entry,
    tag: number,
    recvAt: number,
) {
    const firstSeg = cacheEntry.segments.get(0) as Segment.Segment;
    const requestId = firstSeg.requestId;
    const msgData = SegmentCache.toMessage(cacheEntry);
    const resMsgBytes = Utils.base64ToBytes(msgData);
    if (Res.isErr(resMsgBytes)) {
        log.error('error decoding msgData: %s', resMsgBytes.error);
        return;
    }

    const msgBytes = resMsgBytes.res;
    const pIdBytes = msgBytes.slice(0, 52);
    const reqData = msgBytes.slice(52);
    const entryPeerId = Utils.bytesToString(pIdBytes);

    const resReq = Request.messageToReq({
        requestId,
        message: reqData,
        exitPeerId: state.peerId,
        exitPrivateKey: state.privateKey,
    });

    if (Res.isErr(resReq)) {
        log.error('error unboxing request:', resReq.error);
        return;
    }

    const unboxRequest = resReq.res;
    const { reqPayload, session: unboxSession } = unboxRequest;
    const relay = determineRelay(state, reqPayload);
    const sendParams = { state, ops, entryPeerId, cacheEntry, tag, relay, unboxRequest };

    // check counter
    const counter = Number(unboxSession.updatedTS);
    const now = Date.now();
    const valid = now - ValidCounterPeriod;
    if (counter < valid) {
        log.info('counter %d outside valid period %d (now: %d)', counter, valid, now);
        // counter fail resp
        return sendResponse(sendParams, { type: Payload.RespType.CounterFail, counter: now });
    }

    // check uuid
    const res = await RequestStore.addIfAbsent(state.db, requestId, counter);
    if (res === RequestStore.AddRes.Duplicate) {
        log.info('duplicate request id:', requestId);
        // duplicate fail resp
        return sendResponse(sendParams, { type: Payload.RespType.DuplicateFail });
    }

    // do actual endpoint request
    const fetchStartedAt = performance.now();
    const resFetch = await EndpointApi.fetchUrl(reqPayload.endpoint, reqPayload).catch(
        (err: Error) => {
            log.error(
                'error doing RPC req on %s with %o: %o',
                reqPayload.endpoint,
                reqPayload,
                err,
            );
            // HTTP critical fail response
            const resp: Payload.RespPayload = {
                type: Payload.RespType.Error,
                reason: err.toString(),
            };
            return sendResponse(sendParams, resp);
        },
    );
    if (!resFetch) {
        return;
    }

    const fetchDur = Math.round(performance.now() - fetchStartedAt);
    const resp: Payload.RespPayload = {
        type: Payload.RespType.Resp,
        ...resFetch,
    };
    return sendResponse(sendParams, addLatencies(reqPayload, resp, { fetchDur, recvAt }));
}

/**
 * The exit node will only select a relay if one was given via request payload.
 * It will check if that is a valid relay, otherwise it will choose one of the relays determine by itself.
 */
function determineRelay(state: State, { hops, relayPeerId }: Payload.ReqPayload) {
    if (hops === 0) {
        return;
    }
    if (relayPeerId) {
        if (state.relays.includes(relayPeerId)) {
            return relayPeerId;
        } else {
            return Utils.randomEl(state.relays);
        }
    }
}

/**
 * The exit node will send tracked latency back if requested.
 */
function addLatencies(
    { withDuration }: Payload.ReqPayload,
    resp: Payload.RespPayload,
    { fetchDur, recvAt }: { fetchDur: number; recvAt: number },
): Payload.RespPayload {
    if (!withDuration) {
        return resp;
    }
    switch (resp.type) {
        case Payload.RespType.Resp: {
            const dur = Math.round(performance.now() - recvAt);
            resp.callDuration = fetchDur;
            resp.exitAppDuration = dur - fetchDur;
            return resp;
        }
        default:
            return resp;
    }
}

function sendResponse(
    {
        state,
        ops,
        entryPeerId,
        cacheEntry,
        tag,
        unboxRequest: { session: unboxSession, reqPayload },
        relay,
    }: {
        state: State;
        ops: Ops;
        entryPeerId: string;
        tag: number;
        cacheEntry: SegmentCache.Entry;
        unboxRequest: Request.UnboxRequest;
        relay?: string;
    },
    respPayload: Payload.RespPayload,
) {
    const requestId = (cacheEntry.segments.get(0) as Segment.Segment).requestId;
    const resResp = Response.respToMessage({
        requestId,
        entryPeerId,
        respPayload,
        unboxSession,
    });
    if (Res.isErr(resResp)) {
        log.error('error boxing response:', resResp.error);
        return;
    }

    const segments = Segment.toSegments(requestId, resResp.res);

    const relayString = relay ? `(r${Utils.shortPeerId(relay)})` : '';

    log.verbose(
        'returning message to e%s%s, tag: %s, requestId: %s, segmentCount: %d',
        Utils.shortPeerId(entryPeerId),
        relayString,
        tag,
        requestId,
        segments.length,
    );

    const conn = {
        ...ops,
        hops: reqPayload.hops,
        respRelayPeerId: relay,
    };

    // queue segment sending for all of them
    const ts = Date.now();
    segments.forEach((seg: Segment.Segment, idx) => {
        setTimeout(function () {
            ResponseSegmentStore.put(state.db, seg, ts);
            NodeApi.sendMessage(conn, {
                recipient: entryPeerId,
                tag,
                message: Segment.toMessage(seg),
            }).catch((err: Error) => {
                log.error('error sending %s: %o', Segment.prettyPrint(seg), err);
                // remove relay if it fails
                state.relays = state.relays.filter((r) => r !== relay);
            });
        }, idx);
    });

    if (ops.discoveryPlatform) {
        reportToDiscoveryPlatform({
            cacheEntry,
            opsDP: ops.discoveryPlatform,
            reqPayload,
            segments,
        });
    }
}

async function reportToDiscoveryPlatform({
    cacheEntry,
    opsDP,
    reqPayload,
    segments,
}: {
    cacheEntry: SegmentCache.Entry;
    opsDP: OpsDP;
    reqPayload: Payload.ReqPayload;
    segments: Segment.Segment[];
}) {
    const lastReqSeg = cacheEntry.segments.get(cacheEntry.count - 1) as Segment.Segment;
    const rpcMethod = determineRPCmethod(reqPayload.body);
    const url = new URL(reqPayload.endpoint);
    const domain = url.hostname;

    const quotaRequest: DpApi.QuotaParams = {
        clientId: reqPayload.clientId,
        rpcMethod,
        segmentCount: cacheEntry.count,
        lastSegmentLength: lastReqSeg.body.length,
        chainId: reqPayload.chainId,
        domain,
        type: 'request',
    };

    const lastRespSeg = segments[segments.length - 1];
    const quotaResponse: DpApi.QuotaParams = {
        clientId: reqPayload.clientId,
        rpcMethod,
        segmentCount: segments.length,
        lastSegmentLength: lastRespSeg.body.length,
        chainId: reqPayload.chainId,
        domain,
        type: 'response',
    };

    const conn = {
        discoveryPlatformEndpoint: opsDP.endpoint,
        nodeAccessToken: opsDP.nodeAccessToken,
    };
    DpApi.postQuota(conn, quotaRequest).catch((err) => {
        log.error('error recording request quota: %o', err);
    });
    DpApi.postQuota(conn, quotaResponse).catch((err) => {
        log.error('error recording response quota: %o', err);
    });
}

function determineRPCmethod(body?: string) {
    if (!body) {
        return undefined;
    }

    try {
        const obj = JSON.parse(body);
        if ('method' in obj) {
            return obj.method;
        }
    } catch (err) {
        log.warn('Error parsing unknown string with JSON: %s [%s]', err, body);
        return undefined;
    }
}

function connectWS({ apiEndpoint, accessToken }: Ops): WebSocket {
    const wsURL = new URL('/api/v3/messages/websocket', apiEndpoint);
    wsURL.protocol = apiEndpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    wsURL.search = `?apiToken=${accessToken}`;
    return new WebSocket(wsURL);
}

// if this file is the entrypoint of the nodejs process
if (require.main === module) {
    if (!process.env.UHTTP_EA_PRIVATE_KEY) {
        throw new Error("Missing 'UHTTP_EA_PRIVATE_KEY' env var.");
    }
    if (!process.env.UHTTP_EA_PUBLIC_KEY) {
        throw new Error("Missing 'UHTTP_EA_PUBLIC_KEY' env var.");
    }
    if (!process.env.UHTTP_EA_HOPRD_ENDPOINT) {
        throw new Error("Missing 'UHTTP_EA_HOPRD_ENDPOINT' env var.");
    }
    if (!process.env.UHTTP_EA_HOPRD_ACCESS_TOKEN) {
        throw new Error("Missing 'UHTTP_EA_HOPRD_ACCESS_TOKEN' env var.");
    }
    if (!process.env.UHTTP_EA_DATABASE_FILE) {
        throw new Error("Missing 'UHTTP_EA_DATABASE_FILE' env var.");
    }

    const dpEndpoint = process.env.UHTTP_EA_DISCOVERY_PLATFORM_ENDPOINT;
    let discoveryPlatform;
    if (dpEndpoint) {
        if (!process.env.UHTTP_EA_DISCOVERY_PLATFORM_ACCESS_TOKEN) {
            throw new Error(
                "Missing 'UHTTP_EA_DISCOVERY_PLATFORM_ACCESS_TOKEN' env var alongside provided UHTTP_EA_DISCOVERY_PLATFORM_ENDPOINT.",
            );
        }
        discoveryPlatform = {
            endpoint: dpEndpoint,
            nodeAccessToken: process.env.UHTTP_EA_DISCOVERY_PLATFORM_ACCESS_TOKEN,
        };
    }

    start({
        privateKey: process.env.UHTTP_EA_PRIVATE_KEY,
        publicKey: process.env.UHTTP_EA_PUBLIC_KEY,
        apiEndpoint: new URL(process.env.UHTTP_EA_HOPRD_ENDPOINT),
        accessToken: process.env.UHTTP_EA_HOPRD_ACCESS_TOKEN,
        discoveryPlatform,
        dbFile: process.env.UHTTP_EA_DATABASE_FILE,
    });
}
