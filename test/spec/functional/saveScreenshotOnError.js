import merge  from 'deepmerge'
import conf from '../../conf/index.js'
import fs from 'fs'
import nock from 'nock'
import sinon from 'sinon'

const WebdriverIO = require('../../../')

const FAKE_SESSION_RESPONSE = {
    sessionId: '31571f3a-4824-4378-b352-65de24952903',
    status: 0
}

const FAKE_SUCCESS_RESPONSE = {
    status: 0,
    value: 'ok'
}

describe.only('saving screenshot on error', function() {

    let client

    beforeEach(function() {
        let localConf = merge({}, conf)
        localConf.screenshotPath = 'some_directory'
        localConf.connectionRetryCount = 1
        client = WebdriverIO.remote(localConf)

        // for screenshot
        sinon.stub(fs, 'statSync').returns(true)
        sinon.stub(fs, 'writeFileSync').yields(true)
    })

    afterEach(function() {
        fs.statSync.restore()
        fs.writeFileSync.restore()
        nock.cleanAll()
    })

    it('should save screenshot before session end', async function() {

        nock('http://localhost:4444')
            .post('/wd/hub/session')
                .reply(200, FAKE_SESSION_RESPONSE)
            .post('/wd/hub/session/31571f3a-4824-4378-b352-65de24952903/element')
                .replyWithError('some error')
            .get('/wd/hub/session/31571f3a-4824-4378-b352-65de24952903/screenshot')
                .delayConnection(200)
                .reply(200, FAKE_SUCCESS_RESPONSE)

        // finally call — client.end
        let spy = sinon.spy()
        await client.init().click('#notExists').finally(spy)

        // setTimeout(function() {
            expect(fs.writeFile.calledOnce).to.be.true
            expect(fs.writeFile.calledBefore(spy)).to.be.true
            // done()
        // }, 300)
    })

    it('should not be the cause of recursion', async function() {

        let spy = sinon.stub().returns('some error')

        nock('http://localhost:4444')
            .post('/wd/hub/session')
                .reply(200, FAKE_SESSION_RESPONSE)
            .post('/wd/hub/session/31571f3a-4824-4378-b352-65de24952903/element')
                .replyWithError('some error')
            .get('/wd/hub/session/31571f3a-4824-4378-b352-65de24952903/screenshot')
                .times(Infinity)
                .reply(500, spy)

        await client.init().click('#notExists')

        // setTimeout(function() {
            expect(fs.writeFile.called).to.be.false
            expect(spy.calledOnce).to.be.true
            // done()
        // }, 100)
    })

})
