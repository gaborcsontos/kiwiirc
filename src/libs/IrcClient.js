'kiwi public';

import _ from 'lodash';
import strftime from 'strftime';
import Irc from 'irc-framework/browser';
import * as TextFormatting from '@/helpers/TextFormatting';
import * as Misc from '@/helpers/Misc';
import bouncerMiddleware from './BouncerMiddleware';
import * as ServerConnection from './ServerConnection';

export function create(state, network) {
    let networkid = network.id;

    let clientOpts = {
        host: network.connection.server,
        port: network.connection.port,
        tls: network.connection.tls,
        path: network.connection.path,
        password: network.connection.password,
        nick: network.nick,
        username: network.username || network.nick,
        gecos: network.gecos || 'https://kiwiirc.com/',
        version: null,
        auto_reconnect: false,
        encoding: network.connection.encoding,
    };

    // A direct connection uses a websocket to connect (note: some browsers limit
    // the number of connections to the same host!).
    // A non-direct connection will connect via the configured kiwi server using
    // with our own irc-framework compatible transport.
    if (!network.connection.direct) {
        clientOpts.transport = ServerConnection.createChannelConstructor(
            state.settings.kiwiServer,
            (window.location.hash || '').substr(1),
            networkid
        );
    }

    let ircClient = new Irc.Client(clientOpts);
    ircClient.requestCap('znc.in/self-message');
    ircClient.use(clientMiddleware(state, network));
    ircClient.use(bouncerMiddleware());

    // Overload the connect() function to make sure we are connecting with the
    // most recent connection details from the state
    let originalIrcClientConnect = ircClient.connect;
    ircClient.connect = function connect(...args) {
        let bnc = state.setting('bnc');
        if (bnc.active) {
            let netname = network.connection.bncname;
            let password = '';

            // bnccontrol is the control connection for BOUNCER commands, not a network
            if (network.name === 'bnccontrol') {
                // Some bouncers require a network to be set, so set a (hopefully) invalid one
                password = `${bnc.username}/__kiwiauth:${bnc.password}`;
            } else {
                password = `${bnc.username}/${netname}:${bnc.password}`;
            }

            ircClient.options.host = bnc.server;
            ircClient.options.port = bnc.port;
            ircClient.options.tls = bnc.tls;
            ircClient.options.password = password;
            ircClient.options.nick = network.nick;
            ircClient.options.username = bnc.username;
            ircClient.options.encoding = network.connection.encoding;
        } else {
            ircClient.options.host = network.connection.server;
            ircClient.options.port = network.connection.port;
            ircClient.options.tls = network.connection.tls;
            ircClient.options.password = network.connection.password;
            ircClient.options.nick = network.nick;
            ircClient.options.username = network.username || network.nick;
            ircClient.options.gecos = network.gecos || 'https://kiwiirc.com/';
            ircClient.options.encoding = network.connection.encoding;
        }

        state.$emit('network.connecting', { network });
        originalIrcClientConnect.apply(ircClient, args);
    };

    ircClient.on('raw', (event) => {
        if (!network.setting('show_raw') && !state.setting('showRaw')) {
            return;
        }

        let buffer = state.getOrAddBufferByName(networkid, '*raw');
        state.addMessage(buffer, {
            time: Date.now(),
            nick: '',
            message: (event.from_server ? '[S] ' : '[C] ') + event.line,
        });
    });

    return ircClient;
}

function clientMiddleware(state, network) {
    let networkid = network.id;
    let numConnects = 0;
    // Requested chathistory for this connection yet
    let requestedCh = false;

    return function middlewareFn(client, rawEvents, parsedEvents) {
        parsedEvents.use(parsedEventsHandler);
        rawEvents.use(rawEventsHandler);

        client.on('connecting', () => {
            network.state_error = '';
            network.state = 'connecting';
            network.last_error = '';
        });

        client.on('connected', () => {
            network.state_error = '';
            network.state = 'connected';

            network.buffers.forEach((buffer) => {
                if (!buffer) {
                    return;
                }

                let messageBody = TextFormatting.formatText('network_connected', {
                    text: TextFormatting.t('connected'),
                });

                state.addMessage(buffer, {
                    time: Date.now(),
                    nick: '',
                    message: messageBody,
                    type: 'connection',
                    type_extra: 'connected',
                });
            });
        });

        client.on('socket close', (err) => {
            network.state = 'disconnected';
            network.state_error = err || '';

            network.buffers.forEach((buffer) => {
                if (!buffer) {
                    return;
                }

                buffer.joined = false;
                buffer.clearUsers();

                let messageBody = TextFormatting.formatText('network_disconnected', {
                    text: TextFormatting.t('disconnected'),
                });

                state.addMessage(buffer, {
                    time: Date.now(),
                    nick: '',
                    message: messageBody,
                    type: 'connection',
                    type_extra: 'disconnected',
                });
            });
        });

        client.on('socket connected', () => {
            if (network.captchaResponse) {
                client.raw('CAPTCHA', network.captchaResponse);
            }
        });
    };

    function rawEventsHandler(command, event, rawLine, client, next) {
        state.$emit('irc.raw', command, event, network);
        state.$emit('irc.raw.' + command, command, event, network);
        next();
    }

    function parsedEventsHandler(command, event, client, next) {
        // Trigger this event through the state object first. If it's been handled
        // somewhere else then we ignore it.
        let ircEventObj = { handled: false };
        state.$emit('irc.' + command, event, network, ircEventObj);
        if (ircEventObj.handled) {
            next();
            return;
        }

        // Ignore any of the control messages. They're transport related to kiwi internals
        if (event && event.command === 'CONTROL') {
            next();
            return;
        }

        if (command === 'channel_redirect') {
            let b = network.bufferByName(event.from);
            if (b) {
                b.flags.redirect_to = event.to;
            }
        }

        if (command === 'registered') {
            if (client.options.nickserv) {
                let options = client.options.nickserv;
                client.say('nickserv', 'identify ' + options.account + ' ' + options.password);
            }

            network.nick = event.nick;
            state.addUser(networkid, { nick: event.nick, username: client.user.username });

            let serverBuffer = network.serverBuffer();
            state.addMessage(serverBuffer, {
                time: Date.now(),
                nick: '',
                message: TextFormatting.t('connected_to', { network: client.network.name }),
            });

            // Get some extra info about ourselves
            client.raw('WHO ' + event.nick);

            if (network.auto_commands) {
                network.auto_commands.split('\n').forEach((line) => {
                    state.$emit('input.raw', line[0] === '/' ? line : `/${line}`);
                });
            }

            // Join our channels
            // If under bouncer mode, the bouncer will send the channels were joined to instead.
            if (!network.connection.bncname) {
                network.buffers.forEach((buffer) => {
                    if (buffer.isChannel() && buffer.enabled) {
                        client.join(buffer.name, buffer.key);
                    }
                });
            }

            // Haven't yet requested chathistory for this connection
            requestedCh = false;
            numConnects++;
        }

        if (command === 'server options') {
            // If the network name has changed from the irc-framework default, update ours
            if (client.network.name !== 'Network') {
                network.name = client.network.name;
            }

            let historySupport = !!network.ircClient.network.supports('chathistory');

            // If this is a reconnect then request chathistory from our last position onwards
            // to get any missed messages
            if (numConnects > 1 && !requestedCh && historySupport) {
                requestedCh = true;
                network.buffers.forEach((buffer) => {
                    if (buffer.isChannel() || buffer.isQuery()) {
                        buffer.requestScrollback('forward');
                    }
                });
            }

            // The first time we connect, request the last 50 messages for every buffer we have
            // if CHATHISTORY is supported
            if (numConnects === 1 && !requestedCh && historySupport) {
                requestedCh = true;
                let time = Misc.dateIso();
                network.buffers.forEach((buffer) => {
                    if (buffer.isChannel() || buffer.isQuery()) {
                        let line = `CHATHISTORY ${buffer.name} timestamp=${time} message_count=-50`;
                        network.ircClient.raw(line);
                    }
                });
            }
        }

        // Show unhandled data from the server in the servers tab
        if (command === 'unknown command') {
            if (event.command === '486') {
                // You must log in with services to message this user
                let targetNick = event.params[1];
                let buffer = state.getOrAddBufferByName(network.id, targetNick);
                state.addMessage(buffer, {
                    time: Date.now(),
                    nick: '*',
                    message: event.params[2],
                    type: 'error',
                });
            } else {
                let buffer = network.serverBuffer();
                let message = '';

                // Only show non-numeric commands
                if (!event.command.match(/^\d+$/)) {
                    message += event.command + ' ';
                }

                let containsNick = event.params[0] === network.ircClient.user.nick;
                let isChannelMessage = network.isChannelName(event.params[1]);

                // Strip out the nick if it's the first params (many commands include this)
                if (containsNick && isChannelMessage) {
                    let channelBuffer = network.bufferByName(event.params[1]);
                    if (channelBuffer) {
                        buffer = channelBuffer;
                    }
                    message += event.params.slice(2).join(', ');
                } else if (containsNick) {
                    message += event.params.slice(1).join(', ');
                } else {
                    message += event.params.join(', ');
                }

                state.addMessage(buffer, {
                    nick: '',
                    message: message,
                });
            }
        }

        if (command === 'message') {
            let isPrivateMessage = false;
            let bufferName = event.from_server ? '*' : event.target;

            // PMs should go to a buffer with the name of the other user
            if (!event.from_server && event.target === client.user.nick) {
                isPrivateMessage = true;
                bufferName = event.nick;
            }

            // Chanserv sometimes PMs messages about a channel on join in the format of
            // [#channel] welcome!
            // Redirect these to #channel
            if (
                event.nick.toLowerCase() === 'chanserv' &&
                isPrivateMessage &&
                event.message[0] === '['
            ) {
                bufferName = event.message.substr(1, event.message.indexOf(']') - 1);
            }

            // Notices from somewhere when we don't have an existing buffer for them should go into
            // the server tab. ie. notices from servers
            if (event.type === 'notice') {
                let existingBuffer = state.getBufferByName(networkid, bufferName);
                let noticeActiveBuffer = state.setting('noticeActiveBuffer');
                let activeBuffer = state.getActiveBuffer();
                let hasActiveBuffer = activeBuffer && activeBuffer.networkid === networkid;

                // If we don't have a buffer for this notice sender, either show it in our active
                // buffer or the server buffer
                if (!existingBuffer) {
                    if (noticeActiveBuffer && hasActiveBuffer) {
                        bufferName = activeBuffer.name;
                    } else {
                        bufferName = '*';
                    }
                }
            }

            let blockNewPms = state.setting('buffers.block_pms');
            let buffer = state.getBufferByName(networkid, bufferName);
            if (isPrivateMessage && !buffer && blockNewPms) {
                return;
            } else if (!buffer) {
                buffer = state.getOrAddBufferByName(networkid, bufferName);
            }

            let textFormatType = 'privmsg';
            if (event.type === 'action') {
                textFormatType = 'action';
            } else if (event.type === 'notice') {
                textFormatType = 'notice';
            }

            let messageBody = TextFormatting.formatText(textFormatType, {
                nick: event.nick,
                username: event.ident,
                host: event.hostname,
                text: event.message,
            });

            state.addMessage(buffer, {
                time: event.time || Date.now(),
                nick: event.nick,
                message: messageBody,
                type: event.type,
                tags: event.tags || {},
            });
        }

        if (command === 'wallops') {
            let buffer = state.getOrAddBufferByName(networkid, '*');
            let messageBody = TextFormatting.formatText('wallops', {
                text: event.message,
            });

            state.addMessage(buffer, {
                time: event.time || Date.now(),
                nick: event.nick,
                message: messageBody,
                type: 'wallops',
            });
        }

        if (command === 'join') {
            // If we have any buffers marked as being redirected to this new channel, update
            // that buffer instead of creating a new one
            if (event.nick === client.user.nick) {
                network.buffers.forEach((b) => {
                    if ((b.flags.redirect_to || '').toLowerCase() === event.channel.toLowerCase()) {
                        state.$delete(b.flags, 'redirect_to');
                        b.rename(event.channel);
                    }
                });
            }

            let buffer = state.getOrAddBufferByName(networkid, event.channel);

            state.addUserToBuffer(buffer, {
                nick: event.nick,
                username: event.ident,
                host: event.hostname,
                realname: event.gecos,
                account: event.account || '',
            });

            if (event.nick === client.user.nick) {
                buffer.enabled = true;
                buffer.joined = true;
                buffer.flags.channel_badkey = false;
                network.ircClient.raw('MODE', event.channel);
                network.ircClient.who(event.channel);
            }

            let nick = buffer.setting('show_hostnames') ?
                TextFormatting.formatUserFull(event) :
                TextFormatting.formatUser(event);

            let messageBody = TextFormatting.formatAndT(
                'channel_join',
                null,
                'has_joined',
                { nick: nick }
            );

            state.addMessage(buffer, {
                time: Date.now(),
                nick: event.nick,
                message: messageBody,
                type: 'traffic',
                type_extra: 'join',
            });
        }
        if (command === 'kick') {
            let buffer = state.getOrAddBufferByName(networkid, event.channel);
            state.removeUserFromBuffer(buffer, event.kicked);

            let messageBody = '';

            if (event.kicked === client.user.nick) {
                buffer.joined = false;
                buffer.clearUsers();

                messageBody = TextFormatting.formatAndT(
                    'channel_selfkick',
                    { reason: event.message },
                    'kicked_you_from',
                    {
                        nick: TextFormatting.formatUser(event),
                        channel: event.channel,
                    }
                );
            } else {
                messageBody = TextFormatting.formatAndT(
                    'channel_kicked',
                    { reason: event.message },
                    'was_kicked_from',
                    {
                        nick: event.kicked,
                        channel: event.channel,
                        chanop: TextFormatting.formatUser(event.nick),
                    }
                );
            }

            state.addMessage(buffer, {
                time: Date.now(),
                nick: event.nick,
                message: messageBody,
                type: 'traffic',
                type_extra: 'kick',
            });
        }
        if (command === 'part') {
            let buffer = state.getBufferByName(networkid, event.channel);
            if (!buffer) {
                return;
            }

            state.removeUserFromBuffer(buffer, event.nick);
            if (event.nick === client.user.nick) {
                buffer.joined = false;
                buffer.enabled = false;
                buffer.clearUsers();
            }

            // Remove the user from network state if no remaining common channels
            let remainingBuffers = state.getBuffersWithUser(networkid, event.nick);
            if (remainingBuffers.length === 0) {
                state.removeUser(networkid, {
                    nick: event.nick,
                });
            }

            let nick = buffer.setting('show_hostnames') ?
                TextFormatting.formatUserFull(event) :
                TextFormatting.formatUser(event);

            let messageBody = TextFormatting.formatAndT(
                'channel_part',
                { reason: event.message },
                'has_left',
                { nick: nick },
            );

            state.addMessage(buffer, {
                time: Date.now(),
                nick: event.nick,
                message: messageBody,
                type: 'traffic',
                type_extra: 'part',
            });
        }
        if (command === 'quit') {
            let buffers = state.getBuffersWithUser(networkid, event.nick);

            buffers.forEach((buffer) => {
                if (!buffer) {
                    return;
                }

                if (event.nick === client.user.nick) {
                    buffer.joined = false;
                    buffer.clearUsers();
                }

                let nick = buffer.setting('show_hostnames') ?
                    TextFormatting.formatUserFull(event) :
                    TextFormatting.formatUser(event);

                let messageBody = TextFormatting.formatAndT(
                    'channel_quit',
                    { reason: event.message },
                    'has_left',
                    { nick: nick }
                );

                state.addMessage(buffer, {
                    time: Date.now(),
                    nick: event.nick,
                    message: messageBody,
                    type: 'traffic',
                    type_extra: 'quit',
                });
            });

            state.removeUser(networkid, {
                nick: event.nick,
            });
        }

        if (command === 'invite') {
            let buffer = network.serverBuffer();
            state.addMessage(buffer, {
                nick: '*',
                message: TextFormatting.t('invited_you', {
                    nick: event.nick,
                    channel: event.channel,
                }),
            });
        }

        if (command === 'account') {
            state.addUser(networkid, { nick: event.nick, account: event.account || '' });
        }

        if (command === 'whois') {
            let obj = {
                nick: event.nick,
                host: event.hostname,
                username: event.ident,
                away: event.away || '',
                realname: event.real_name,
            };

            // Some other optional bits of info
            [
                'actual_host',
                'helpop',
                'bot',
                'server',
                'server_info',
                'operator',
                'channels',
                'modes',
                'idle',
                'logon',
                'registered_nick',
                'account',
                'secure',
                'special',
            ].forEach((prop) => {
                if (typeof event[prop] !== 'undefined') {
                    obj[prop] = event[prop];
                }
            });

            state.addUser(networkid, obj);
        }

        if (command === 'away') {
            state.addUser(networkid, {
                nick: event.nick,
                away: event.message || '',
            });
        }

        if (command === 'back') {
            state.addUser(networkid, {
                nick: event.nick,
                away: '',
            });
        }

        if (command === 'wholist') {
            state.usersTransaction(networkid, (users) => {
                event.users.forEach((user) => {
                    let userObj = {
                        nick: user.nick,
                        host: user.hostname || undefined,
                        username: user.ident || undefined,
                        away: user.away ? 'Away' : '',
                        realname: user.real_name,
                        account: user.account || '',
                    };
                    state.addUser(networkid, userObj, users);
                });
            });
        }

        if (command === 'channel list start') {
            network.channel_list_cache = [];
            network.channel_list_state = 'updating';
        }
        if (command === 'channel list') {
            network.channel_list_state = 'updating';
            // Filter private channels from the channel list
            let filteredEvent = _.filter(event, o => o.channel !== '*');
            // Store the channels in channel_list_cache before moving it all to
            // channel_list at the end. This gives a huge performance boost since
            // it doesn't need to be all reactive for every update
            network.channel_list_cache = (network.channel_list_cache || []).concat(filteredEvent);
        }
        if (command === 'channel list end') {
            network.channel_list = network.channel_list_cache || [];
            network.channel_list_state = 'updated';
            delete network.channel_list_cache;
        }

        if (command === 'motd') {
            let buffer = network.serverBuffer();
            let messageBody = TextFormatting.formatText('motd', {
                text: event.motd,
            });
            state.addMessage(buffer, {
                time: event.time || Date.now(),
                nick: '',
                message: messageBody,
                type: 'motd',
            });
        }

        if (command === 'nick in use' && !client.connection.registered) {
            let newNick = client.user.nick + rand(1, 100);
            let messageBody = TextFormatting.formatAndT(
                'nickname_alreadyinuse',
                null,
                'nick_in_use_retrying',
                { nick: client.user.nick, newnick: newNick },
            );

            network.buffers.forEach((b) => {
                state.addMessage(b, {
                    time: Date.now(),
                    nick: '',
                    message: messageBody,
                    type: 'error',
                });
            });

            client.changeNick(newNick);
        }

        if (command === 'nick in use' && client.connection.registered) {
            let buffer = state.getActiveBuffer();
            buffer && state.addMessage(buffer, {
                time: Date.now(),
                nick: '',
                type: 'error',
                message: `The nickname '${event.nick}' is already in use!`,
            });
        }

        if (command === 'nick') {
            if (event.nick === client.user.nick) {
                network.nick = event.new_nick;
            }

            state.changeUserNick(networkid, event.nick, event.new_nick);

            let messageBody = TextFormatting.formatAndT(
                'nick_changed',
                null,
                'now_known_as',
                { nick: event.nick, newnick: event.new_nick },
            );

            let buffers = state.getBuffersWithUser(networkid, event.new_nick);
            buffers.forEach((buffer) => {
                state.addMessage(buffer, {
                    time: event.time || Date.now(),
                    nick: '',
                    message: messageBody,
                    type: 'nick',
                });
            });
        }

        if (command === 'userlist') {
            let buffer = state.getOrAddBufferByName(networkid, event.channel);
            let users = [];
            event.users.forEach((user) => {
                users.push({
                    user: {
                        nick: user.nick,
                        username: user.ident,
                        hostname: user.hostname,
                    },
                    modes: user.modes,
                });
            });
            state.addMultipleUsersToBuffer(buffer, users);
        }

        if (command === 'channel info') {
            let buffer = network.bufferByName(event.channel);
            if (!buffer) {
                return;
            }

            if (event.modes) {
                let modeStrs = [];

                event.modes.forEach((mode) => {
                    let adding = mode.mode[0] === '+';
                    let modeChar = mode.mode.substr(1);

                    if (adding) {
                        state.$set(buffer.modes, modeChar, mode.param);
                    } else if (!adding) {
                        state.$delete(buffer.modes, modeChar);
                    }

                    modeStrs.push(mode.mode + (mode.param ? ' ' + mode.param : ''));
                });

                if (buffer.flags.requested_modes) {
                    state.addMessage(buffer, {
                        time: event.time || Date.now(),
                        nick: '*',
                        message: buffer.name + ' ' + modeStrs.join(', '),
                    });
                }
            }

            if (event.created_at) {
                buffer.created_at = new Date(event.created_at * 1000);
            }

            if (event.created_at && buffer.flags.requested_modes) {
                let tFormat = buffer.setting('timestamp_full_format');
                let timeCreated = tFormat ?
                    strftime(tFormat, new Date(event.created_at * 1000)) :
                    (new Date(event.created_at * 1000)).toLocaleString();

                state.addMessage(buffer, {
                    time: event.time || Date.now(),
                    nick: '*',
                    message: buffer.name + ' ' + timeCreated,
                });
            }
        }

        if (command === 'mode') {
            let buffer = network.bufferByName(event.target);
            let modeStrs = {};
            if (buffer) {
                // Join all the same mode changes together so they can be shown on one
                // line such as "prawnsalad sets +b on nick1, nick2"
                event.modes.forEach((mode) => {
                    modeStrs[mode.mode] = modeStrs[mode.mode] || [];

                    // If this mode has a user prefix then we need to update the user object
                    let prefix = _.find(network.ircClient.network.options.PREFIX, {
                        mode: mode.mode[1],
                    });

                    if (prefix) {
                        let user = state.getUser(network.id, mode.param);
                        if (user) {
                            let adding = mode.mode[0] === '+';
                            let modes = user.buffers[buffer.id].modes;
                            let modeIdx = modes.indexOf(prefix.mode);

                            // Add or remove the mode from the users mode list
                            if (adding && modeIdx === -1) {
                                modes.push(prefix.mode);
                            } else if (!adding && modeIdx > -1) {
                                modes.splice(modeIdx, 1);
                            }
                        }

                        modeStrs[mode.mode].push({ target: mode.param });
                    } else {
                        // Not a user prefix, add it as a channel mode
                        // TODO: Why are these not appearing as the 'channel info' command?
                        let adding = mode.mode[0] === '+';
                        let modeChar = mode.mode.substr(1);

                        if (adding) {
                            state.$set(buffer.modes, modeChar, mode.param);
                        } else if (!adding) {
                            state.$delete(buffer.modes, modeChar);
                        }

                        modeStrs[mode.mode].push({ target: buffer.name, param: mode.param });
                    }
                });

                // Mode -> locale ID mappings
                let modeLocaleIds = {
                    '+o': 'modes_give_ops',
                    '-o': 'modes_take_ops',
                    '+h': 'modes_give_halfops',
                    '-h': 'modes_take_halfops',
                    '+v': 'modes_give_voice',
                    '-v': 'modes_take_voice',
                    '+a': 'modes_give_admin',
                    '-a': 'modes_take_admin',
                    '+q': 'modes_give_owner',
                    '-q': 'modes_take_owner',
                    '+b': 'modes_gives_ban',
                    '-b': 'modes_takes_ban',
                };

                // Some modes have specific data for its locale data while most
                // use a default. The returned objects are passed to the translation
                // functions to build the translation
                let modeLocaleDataBuilders = {
                    default(targets, mode) {
                        return {
                            mode: mode + (targets[0].param ? ' ' + targets[0].param : ''),
                            target: targets.map(t => t.target).join(', '),
                            nick: event.nick,
                        };
                    },
                    b(targets, mode) {
                        return {
                            mode: mode,
                            target: targets[0].param ? targets[0].param : '',
                            nick: event.nick,
                        };
                    },
                };

                // Show one line per mode, listing each effecting user
                _.each(modeStrs, (targets, mode) => {
                    // Find a locale data builder for this mode
                    let builders = modeLocaleDataBuilders;
                    let localeDataFn = builders[mode[1]] || builders.default;
                    let localeData = localeDataFn(targets, mode);

                    // Translate using the built locale data
                    let localeKey = modeLocaleIds[mode] || 'modes_other';
                    let text = TextFormatting.t(localeKey, localeData);

                    let messageBody = TextFormatting.formatText('mode', {
                        nick: event.nick,
                        username: event.ident,
                        host: event.hostname,
                        target: targets.map(t => t.target).join(', '),
                        text,
                    });
                    state.addMessage(buffer, {
                        time: event.time || Date.now(),
                        nick: '',
                        message: messageBody,
                        type: 'mode',
                    });
                });
            }
        }

        if (command === 'topic') {
            let buffer = state.getOrAddBufferByName(networkid, event.channel);
            buffer.topic = event.topic || '';

            let messageBody = '';

            if (event.nick) {
                messageBody = TextFormatting.formatAndT(
                    'channel_topic',
                    null,
                    'changed_topic_to',
                    { nick: event.nick, topic: event.topic },
                );
            } else {
                messageBody = TextFormatting.formatText('channel_topic', event.topic);
            }

            state.addMessage(buffer, {
                time: event.time || Date.now(),
                nick: '',
                message: messageBody,
                type: 'topic',
            });
        }

        if (command === 'ctcp response' || command === 'ctcp request') {
            let buffer = network.bufferByName(event.target) || network.serverBuffer();
            let textFormatId = command === 'ctcp response' ?
                'ctcp_response' :
                'ctcp_request';
            let messageBody = TextFormatting.formatText(textFormatId, {
                nick: event.nick,
                message: event.message,
                type: event.type,
            });

            state.addMessage(buffer, {
                time: event.time || Date.now(),
                nick: '',
                message: messageBody,
                type: 'error',
            });

            if (command === 'ctcp request' && event.type === 'VERSION') {
                client.ctcpResponse(event.nick, 'VERSION', 'Kiwi IRC');
            }
        }

        if (command === 'irc error') {
            let buffer;
            if (event.channel || event.nick) {
                buffer = state.getOrAddBufferByName(network.id, event.channel || event.nick);
            }
            if (!buffer) {
                buffer = network.serverBuffer();
            }

            // TODO: Some of these errors contain a .error property whcih we can match against,
            // ie. password_mismatch.

            if (event.error === 'bad_channel_key') {
                buffer.flags.channel_badkey = true;
            }

            if (event.reason) {
                network.last_error = event.reason;

                let messageBody = TextFormatting.formatText('general_error', {
                    text: event.reason || event.error,
                });
                state.addMessage(buffer, {
                    time: event.time || Date.now(),
                    nick: '',
                    message: messageBody,
                    type: 'error',
                });
            }

            // Getting an error about a channel while we are not joined means that we couldn't join
            // or do some action on it. Disable it until we manually reattempt to join.
            if (buffer.isChannel() && !buffer.joined) {
                buffer.enabled = false;
            }
        }

        next();
    }
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}
