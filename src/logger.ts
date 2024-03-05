import debug from 'debug';

const ns = 'exit-app';
const verbose = debug(`${ns}:verbose`);
verbose.log = console.log.bind(console);
const info = debug(`${ns}:info`);
info.log = console.info.bind(console);
const warn = debug(`${ns}:warn`);
warn.log = console.warn.bind(console);
const error = debug(`${ns}:error`);
error.log = console.error.bind(console);

export default {
    verbose,
    info,
    warn,
    error,
};
