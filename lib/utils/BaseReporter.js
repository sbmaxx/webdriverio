import tty from 'tty'
import events from 'events'
import supportsColor from 'supports-color'
import sanitize from '../helpers/sanitize'
import crypto from 'crypto'

const ISATTY = tty.isatty(1) && tty.isatty(2)

const COLORS = {
    'pass': 90,
    'fail': 31,
    'bright pass': 92,
    'bright fail': 91,
    'bright yellow': 93,
    'pending': 36,
    'suite': 0,
    'error title': 0,
    'error message': 31,
    'error stack': 90,
    'checkmark': 32,
    'fast': 90,
    'medium': 33,
    'slow': 31,
    'green': 32,
    'light': 90,
    'diff gutter': 90,
    'diff added': 32,
    'diff removed': 31
}

const SYMBOLS_WIN = {
    ok: '\u221A',
    err: '\u00D7',
    dot: '.',
    error: 'F'
}

const SYMBOLS = {
    ok: '✓',
    err: '✖',
    dot: '․',
    error: 'F'
}

const STRINGLIMIT = 10000

class RunnableStats {
    constructor (type) {
        this.type = type
        this.start = new Date()
        this.duration = 0
    }

    end () {
        this.duration = new Date() - this.start
    }
}

class RunnerStats extends RunnableStats {
    constructor (runner) {
        super('runner')
        this.cid = runner.cid
        this.capabilities = runner.capabilities
        this.sanitizedCapabilities = runner.capabilities && sanitize.caps(runner.capabilities)
        this.config = runner.config
        this.specs = {}
    }
}

class SpecStats extends RunnableStats {
    constructor (runner) {
        super('spec')
        this.files = runner.specs
        this.specHash = runner.specHash
        this.suites = {}
        this.output = []
    }
}

class SuiteStats extends RunnableStats {
    constructor (runner) {
        super('suite')
        this.title = runner.title
        this.tests = {}
    }
}

class TestStats extends RunnableStats {
    constructor (runner) {
        super('test')
        this.title = runner.title
        this.state = ''
        this.screenshots = []
        this.output = []
    }
}

class ReporterStats extends RunnableStats {
    constructor () {
        super('base')

        this.counts = {
            suites: 0,
            tests: 0,
            passes: 0,
            pending: 0,
            failures: 0
        }
        this.runners = {}
        this.failures = []
    }

    getCounts () {
        return this.counts
    }

    getFailures () {
        return this.failures.map((test) => {
            test.runningBrowser = ''
            for (let pid of Object.keys(test.runner)) {
                let caps = test.runner[pid]
                test.runningBrowser += '\nrunning'

                if (caps.browserName) {
                    test.runningBrowser += ` ${caps.browserName}`
                }
                if (caps.version) {
                    test.runningBrowser += ` (v${caps.version})`
                }
                if (caps.platform) {
                    test.runningBrowser += ` on ${caps.platform}`
                }

                const host = this.runners[pid].config.host
                if (host && host.indexOf('saucelabs') > -1) {
                    test.runningBrowser += '\nCheck out job at https://saucelabs.com/tests/' + this.runners[pid].sessionID
                }
            }
        })
    }

    runnerStart (runner) {
        this.runners[runner.cid] = new RunnerStats(runner)
    }

    getRunnerStats (runner) {
        if (!this.runners[runner.cid]) throw Error(`Unrecognised runner [${runner.cid}]`)
        return this.runners[runner.cid]
    }

    getSpecHash (runner) {
        if (!runner.specHash) {
            if (!runner.specs) throw Error(`Cannot generate spec hash for runner with no 'specs' key`)
            runner.specHash = crypto.createHash('md5')
                .update(runner.specs.join(''))
                .digest('hex')
        }
        return runner.specHash
    }

    specStart (runner) {
        const specHash = this.getSpecHash(runner)
        this.getRunnerStats(runner).specs[specHash] = new SpecStats(runner)
    }

    getSpecStats (runner) {
        const runnerStats = this.getRunnerStats(runner)
        const specHash = this.getSpecHash(runner)
        if (!runnerStats.specs[specHash]) throw Error(`Unrecognised spec [${specHash}] for runner [${runner.cid}]`)
        return runnerStats.specs[specHash]
    }

    setSessionId (runner) {
        this.getRunnerStats(runner).sessionID = runner.sessionID
    }

    suiteStart (runner) {
        this.getSpecStats(runner).suites[runner.title] = new SuiteStats(runner)
        this.counts.suites++
    }

    getSuiteStats (runner, suiteTitle) {
        const specStats = this.getSpecStats(runner)
        if (!specStats.suites[suiteTitle]) throw Error(`Unrecognised suite [${suiteTitle}] for runner [${specStats.specHash}]`)
        return specStats.suites[suiteTitle]
    }

    testStart (runner) {
        this.getSuiteStats(runner, runner.parent).tests[runner.title] = new TestStats(runner)
    }

    getTestStats (runner) {
        const suiteStats = this.getSuiteStats(runner, runner.parent)
        if (!suiteStats.tests[runner.title]) throw Error(`Unrecognised test [${runner.title}] for suite [${runner.parent}]`)
        return suiteStats.tests[runner.title]
    }

    webdriver (type, runner) {
        if (runner.title && runner.parent) {
            this.getTestStats(runner).output.push({
                type,
                payload: runner
            })
        } else {
            // Log commands, results and screenshots executed outside of a test
            this.getSpecStats(runner).output.push({
                type,
                payload: runner
            })
        }
    }

    testPass (runner) {
        this.getTestStats(runner).state = 'pass'
        this.counts.passes++
    }

    testPending (runner) {
        // Pending tests don't actually start, so won't yet be registered
        this.testStart(runner)
        this.testEnd(runner)
        this.getTestStats(runner).state = 'pending'
        this.counts.pending++
    }

    testFail (runner) {
        const testStats = this.getTestStats(runner)
        testStats.state = 'fail'
        testStats.error = runner.err
        this.counts.failures++

        /**
         * check if error also happened in other runners
         */
        let duplicateError = false
        for (let failure of this.failures) {
            if (runner.err.message !== failure.err.message || failure.title !== runner.title) {
                continue
            }
            duplicateError = true
            failure.runner[runner.cid] = runner.runner[runner.cid]
        }

        if (!duplicateError) {
            this.failures.push(runner)
        }
    }

    testEnd (runner) {
        this.getTestStats(runner).end()
        this.counts.tests++
    }

    suiteEnd (runner) {
        this.getSuiteStats(runner, runner.title).end()
    }

    runnerEnd (runner) {
        this.getSpecStats(runner).end()
    }
}

class BaseReporter extends events.EventEmitter {
    constructor () {
        super()

        this.reporters = []
        this.printEpilogue = true
        this.cursor = new Cursor()
        this.stats = new ReporterStats()

        this.on('start', () => {
            this.propagateEvent('start')
        })

        this.on('runner:start', (runner) => {
            this.stats.runnerStart(runner)
            this.stats.specStart(runner)
            this.propagateEvent('runner:start', runner)
        })

        this.on('runner:init', (runner) => {
            this.stats.setSessionId(runner)
            this.propagateEvent('runner:init', runner)
        })

        this.on('runner:command', (command) => {
            this.stats.webdriver('command', command)
            this.propagateEvent('runner:command', command)
        })

        this.on('runner:result', (result) => {
            this.stats.webdriver('result', result)
            this.propagateEvent('runner:result', result)
        })

        this.on('runner:screenshot', (screenshot) => {
            this.stats.webdriver('screenshot', screenshot)
            this.propagateEvent('runner:screenshot', screenshot)
        })

        this.on('suite:start', (suite) => {
            this.stats.suiteStart(suite)
            this.propagateEvent('suite:start', suite)
        })

        this.on('test:start', (test) => {
            this.stats.testStart(test)
            this.propagateEvent('test:start', test)
        })

        this.on('hook:start', (hook) => {
            this.propagateEvent('hook:start', hook)
        })

        this.on('hook:end', (hook) => {
            this.propagateEvent('hook:end', hook)
        })

        this.on('test:pass', (test) => {
            this.stats.testPass(test)
            this.propagateEvent('test:pass', test)
        })

        this.on('test:fail', (test) => {
            this.stats.testFail(test)
            this.propagateEvent('test:fail', test)
        })

        this.on('test:pending', (test) => {
            this.stats.testPending(test)
            this.propagateEvent('test:pending', test)
        })

        this.on('test:end', (test) => {
            this.stats.testEnd(test)
            this.propagateEvent('test:end', test)
        })

        this.on('suite:end', (runner) => {
            this.stats.suiteEnd(runner)
            this.propagateEvent('suite:end', runner)
        })

        this.on('error', (runner) => {
            this.printEpilogue = false

            var fmt = this.color('error message', 'ERROR: %s')
            console.log(fmt, runner.error.message)

            fmt = this.color('bright yellow', sanitize.caps(runner.capabilities))
            console.log(fmt)

            if (runner.error.stack) {
                fmt = this.color('error stack', runner.error.stack.replace(`Error: ${runner.error.message}\n`, ''))
            } else {
                fmt = this.color('error stack', '    no stack available')
            }
            console.log(fmt)

            this.propagateEvent('error', runner)
        })

        this.on('runner:end', (runner) => {
            this.stats.runnerEnd(runner)
            this.propagateEvent('runner:end', runner)
        })

        this.on('end', (args) => {
            this.stats.end()
            this.printEpilogue = this.printEpilogue && !args.sigint
            this.propagateEvent('end', args)
        })
    }

    /**
     * Color `str` with the given `type`,
     * allowing colors to be disabled,
     * as well as user-defined color
     * schemes.
     *
     * @param {String} type
     * @param {String} str
     * @return {String}
     * @api private
     */
    color (type, str) {
        if (!supportsColor) return String(str)
        return `\u001b[${COLORS[type]}m${str}\u001b[0m`
    }

    limit (val) {
        switch (Object.prototype.toString.call(val)) {
        case '[object String]':
            if (val.length > 100 && val.match(/^([A-Za-z0-9+\/]{4})*([A-Za-z0-9+\/]{4}|[A-Za-z0-9+\/]{3}=|[A-Za-z0-9+\/]{2}==)$/)) {
                return '[base64 string]'
            } else if (val.length > STRINGLIMIT) {
                return val.slice(0, STRINGLIMIT) + '... (' + (val.length - STRINGLIMIT) + ' more bytes)'
            }
            return val
        case '[object Array]':
            return val.map(this.limit.bind(this))
        case '[object Object]':
            const copy = {}
            for (let key of Object.keys(val)) {
                copy[key] = this.limit(val[key])
            }
            return copy
        default:
            return val
        }
    }

    /**
     * Output common epilogue used by many of
     * the bundled reporters.
     *
     * @api public
     */
    epilogue () {
        if (!this.printEpilogue) {
            return
        }

        const counts = this.stats.getCounts()

        console.log('\n')

        // passes
        let fmt = this.color('green', '%d passing') + this.color('light', ' (%ss)')
        console.log(fmt, counts.passes || 0, ((Math.round(this.stats.duration / 100)) / 10).toFixed(2))

        // pending
        if (counts.pending) {
            fmt = this.color('pending', '%d pending')
            console.log(fmt, counts.pending)
        }

        // failures
        if (counts.failures) {
            fmt = this.color('fail', '%d failing')
            console.log(fmt, counts.failures)
            this.listFailures()
        }

        console.log()

        this.printEpilogue = false
    }

    /**
     * Outut the given failures as a list
     */
    listFailures () {
        console.log()
        this.stats.getFailures().forEach((test, i) => {
            let fmt = this.color('error title', '%s) %s:\n') +
                      this.color('error message', '%s') +
                      this.color('bright yellow', '%s') +
                      this.color('error stack', '\n%s\n')
            console.log(fmt, (i + 1), test.title, test.err.message, test.runningBrowser, test.err.stack)
        })
    }

    add (reporter) {
        this.reporters.push(reporter)
    }

    propagateEvent (...args) {
        if (this.reporters.length === 0) {
            return
        }

        for (const reporter of this.reporters) {
            /**
             * skip reporter if
             * 	- he isn't an eventemitter
             * 	- event is not registered
             */
            if (typeof reporter.emit !== 'function' || Object.keys(reporter._events).indexOf(args[0]) < 0) {
                continue
            }

            reporter.emit.apply(reporter, args)
        }
    }

    /**
     * Default color map.
     */
    get colors () {
        return COLORS
    }

    /**
     * Default symbol map.
     */
    get symbols () {
        /**
         * With node.js on Windows: use symbols available in terminal default fonts
         */
        if (process.platform === 'win32') {
            return SYMBOLS_WIN
        }

        return SYMBOLS
    }
}

/**
 * Expose some basic cursor interactions
 * that are common among reporters.
 */
class Cursor {
    hide () {
        ISATTY && process.stdout.write('\u001b[?25l')
    }

    show () {
        ISATTY && process.stdout.write('\u001b[?25h')
    }

    deleteLine () {
        ISATTY && process.stdout.write('\u001b[2K')
    }

    beginningOfLine () {
        ISATTY && process.stdout.write('\u001b[0G')
    }

    CR () {
        if (ISATTY) {
            this.deleteLine()
            this.beginningOfLine()
        } else {
            process.stdout.write('\r')
        }
    }

    get isatty () {
        return ISATTY
    }
}

export default BaseReporter
export { Cursor }