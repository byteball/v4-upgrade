// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const path = require('path')
const objectHash = require("ocore/object_hash.js");
const objectLength = require("ocore/object_length.js");
const constants = require("ocore/constants.js");
//const conf = require("ocore/conf.js");

const AA_PATH = '../agent.aa'
const countOPs = 3
//conf.spend_unconfirmed = 'all'

/*
+ change OPs
+ change numeric
+ emergency change OPs
+ pricing of temp data
+ purging of temp data
+ temp rejects
*/

function wait(ms) {
	return new Promise(r => setTimeout(r, ms));
}

describe('Check v4 upgrade', function () {
	this.timeout(120000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(countOPs)
			.with.agent({ simpleAgent: path.join(__dirname, AA_PATH) })
			.with.wallet({ alice: 501000e9 })
			.with.wallet({ bob: 1e3 })
		//	.with.explorer()
			.run()
		
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()

		this.timetravel = async (shift = '1d') => {
			const { error, timestamp } = await this.network.timetravel({ shift })
			if (error) console.log(error)
			expect(error).to.be.null
			return timestamp
		}
	})

	it('Send bytes and check balance', async () => {
		const { unit } = await this.network.wallet.alice.sendBytes({
			toAddress: await this.network.wallet.bob.getAddress(),
			amount: 10000
		})
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)

		const bobBalance = await this.network.wallet.bob.getBalance()
		expect(bobBalance.base.pending).to.be.equal(0)
		expect(bobBalance.base.stable).to.be.equal(11000)

		const aliceBalance = await this.network.wallet.alice.getBalance()
		console.log(aliceBalance)
		expect(aliceBalance.base.pending).to.be.equal(0)
	//	expect(aliceBalance.base.stable).to.be.equal(989626)
	}).timeout(60000)

	it('Trigger AA', async () => {
		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.network.agent.simpleAgent,
			amount: 10000,
			data: {
				a: 100,
				b: 200
			}
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
		console.log(unitObj)

		const { response } = await this.network.getAaResponseToUnitOnNode(this.network.wallet.alice, unit)
		expect(response.response.responseVars.result).to.be.equal(300)
	})


	it('Send temp data', async () => {
		const temp_data = {
			nested: {
				field: 'Some text'
			}
		};
	//	const temp_data = 'Some text';
		const data_length = objectLength.getLength(temp_data, true)
	//	expect(data_length).to.eq(temp_data.length)
		const data_hash = objectHash.getBase64Hash(temp_data, true)
		const { unit, error } = await this.alice.sendMulti({
			messages: [{
				app: 'temp_data',
				payload: {
					data_length,
					data_hash,
					data: temp_data,
				}
			}],
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		this.tempDataUnit = unit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
		console.log(unitObj)
		const paymentMessage = unitObj.messages.find(m => m.app === 'payment')
		const tempDataMessage = unitObj.messages.find(m => m.app === 'temp_data')
		console.log('alice temp data', tempDataMessage)
		expect(tempDataMessage.payload.data).to.deep.eq(temp_data)
		expect(tempDataMessage.payload.data_length).to.eq(objectLength.getLength(tempDataMessage.payload.data, true))
		expect(unitObj.payload_commission).to.eq("messages".length + objectLength.getLength(paymentMessage, true) + "app".length + "temp_data".length + "payload".length + "data_length".length + 8 + "data_hash".length + constants.HASH_LENGTH + Math.ceil((objectLength.getLength(tempDataMessage.payload.data, true) + 4) / 2) + "payload_location".length + "inline".length + "payload_hash".length + constants.HASH_LENGTH)

		await this.network.witnessUntilStable(unit)
		await this.timetravel('2d')
		
		await this.alice.getUnitInfo({ unit: this.tempDataUnit }) // just to trigger the purge
		await wait(100)
		const { unitObj: u2 } = await this.alice.getUnitInfo({ unit: this.tempDataUnit })
		const tempDataMessage2 = u2.messages.find(m => m.app === 'temp_data')
		console.log('alice temp data after 2 days', tempDataMessage2)
		expect(tempDataMessage2.payload.data).to.be.undefined
	})


	it('Create new OPs', async () => {

		let wallets = [];
		let addresses = [];
		for (let i = 0; i < countOPs; i++){
			const wallet = await this.network.newObyteWitness().ready()
			const { timestamp } = await this.network.genesisNode.timetravel({ shift: 0 })
			const { error } = await wallet.timetravel({ to: timestamp }) // sync with the rest of the network
			expect(error).to.be.null			
			const address = await wallet.getAddress()
			console.log('new witness', address)
			wallets.push(wallet)
			addresses.push(address)
		}
		addresses.sort()
		this.newOpAddresses = addresses

		console.log('waiting for sync')
		await this.network.sync()
		console.log('synced, will fund the new OPs')

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: addresses.map(address => ({ address, amount: 1e9 })),
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		console.log(unit, 'waiting for sync', addresses)
		await this.network.sync()
		console.log('synced')

		const all_witnesses = this.network.nodes.witnesses
		this.all_witnesses = all_witnesses
		console.log('current witnesses', await Promise.all(all_witnesses.map(w => w.getAddress())))
		const old_witnesses = all_witnesses.slice(0, countOPs - 1)
		this.new_witnesses = all_witnesses.slice(countOPs - 1)
		this.network.nodes.witnesses = old_witnesses
		await this.network.witnessUntilStable(unit)

		let postingUnit;
		for (let i = 0; i < countOPs; i++){
			console.log('will post from', addresses[i])
			const unit  = await wallets[i].postWitness()
			expect(unit).to.be.validUnit
			postingUnit = unit
			await this.network.sync()
		}
		await this.network.witnessUntilStable(postingUnit)

		const { unitObj: u2 } = await wallets[0].getUnitInfo({ unit: this.tempDataUnit })
		const tempDataMessage2 = u2.messages.find(m => m.app === 'temp_data')
		console.log('temp data on a new node', tempDataMessage2)
		expect(tempDataMessage2.payload.data).to.be.undefined
	})


	it('Vote for new OPs', async () => {
		const burn_fee = 1e6
		const balance_before = (await this.alice.getBalance()).base.total
		const { unit, error } = await this.alice.sendMulti({
			burn_fee,
			messages: [{
				app: 'system_vote',
				payload: {
					subject: 'op_list',
					value: this.newOpAddresses,
				}
			}],
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
	//	console.log(unitObj)
		const balance_after = (await this.alice.getBalance()).base.total
		expect(balance_after).to.be.eq(balance_before - burn_fee - unitObj.headers_commission - unitObj.payload_commission - unitObj.tps_fee);
		await this.network.witnessUntilStable(unit)
	})
	
	it('Vote for new base tps fee', async () => {
		const { unit, error } = await this.alice.sendMulti({
			messages: [{
				app: 'system_vote',
				payload: {
					subject: 'base_tps_fee',
					value: 100.3,
				}
			}],
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
	//	console.log(unitObj)
		await this.network.witnessUntilStable(unit)
	})
	

	it('Activate the new OPs', async () => {
		const balance_before = (await this.alice.getBalance()).base.total
		const { unit, error } = await this.alice.sendMulti({
			messages: [{
				app: 'system_vote_count',
				payload: 'op_list',
			}],
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
		console.log(unitObj)
		const balance_after = (await this.alice.getBalance()).base.total
		expect(balance_after).to.be.eq(balance_before - 1e9 - unitObj.headers_commission - unitObj.payload_commission - unitObj.tps_fee);
		await this.network.witnessUntilStable(unit)
		this.network.initialWitnesses = this.newOpAddresses
		this.network.nodes.witnesses = this.new_witnesses
	//	this.network.nodes.witnesses = this.all_witnesses
	})

	it('Activate the new base tps fee', async () => {
		await this.timetravel('1s')
		const balance_before = (await this.alice.getBalance()).base.total
		const { unit, error } = await this.alice.sendMulti({
			messages: [{
				app: 'system_vote_count',
				payload: 'base_tps_fee',
			}],
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
		console.log(unitObj)
		const balance_after = (await this.alice.getBalance()).base.total
		expect(balance_after).to.be.eq(balance_before - 1e9 - unitObj.headers_commission - unitObj.payload_commission - unitObj.tps_fee);
		await this.network.witnessUntilStable(unit)
	})


	it('Trigger AA again under new OPs', async () => {
		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.network.agent.simpleAgent,
			amount: 10000,
			data: {
				a: 100,
				b: 200
			}
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
		console.log(unitObj)

		const { response } = await this.network.getAaResponseToUnitOnNode(this.network.wallet.alice, unit)
		expect(response.response.responseVars.result).to.be.equal(300)
	})


	it('Create new OPs for emergency change', async () => {
		let wallets = [];
		let addresses = [];
		for (let i = 0; i < countOPs; i++){
			const wallet = await this.network.newObyteWitness().ready()
			const { timestamp } = await this.network.genesisNode.timetravel({ shift: 0 })
			const { error } = await wallet.timetravel({ to: timestamp }) // sync with the rest of the network
			expect(error).to.be.null			

			const address = await wallet.getAddress()
			console.log('new emergency witness', address)
			wallets.push(wallet)
			addresses.push(address)
		}
		addresses.sort()
		this.emergencyOpAddresses = addresses

		console.log('waiting for sync')
		await this.network.sync()
		console.log('synced, will fund the new OPs')
		await this.timetravel('10s')
	
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: addresses.map(address => ({ address, amount: 1e9 })),
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		console.log(unit, 'waiting for sync')
		await this.network.sync()
		console.log('synced')

		const all_witnesses = this.network.nodes.witnesses
		console.log('current witnesses', await Promise.all(all_witnesses.map(w => w.getAddress())))
		const old_witnesses = all_witnesses.slice(0, countOPs)
		this.new_witnesses = all_witnesses.slice(countOPs)
		this.network.nodes.witnesses = old_witnesses
		await this.network.witnessUntilStable(unit)

		let postingUnit;
		for (let i = 0; i < countOPs; i++){
			console.log('will post from', addresses[i])
			const unit  = await wallets[i].postWitness()
			expect(unit).to.be.validUnit
			postingUnit = unit
			await this.network.sync()
		}
		await this.network.witnessUntilStable(postingUnit)
		await this.network.sync()
		
		// activate the emergency OP list immediately
		this.network.nodes.witnesses = this.new_witnesses
		this.network.initialWitnesses = this.emergencyOpAddresses
	})

	it('Vote for new OPs in emergency', async () => {
		await this.timetravel('4d')

		const { unit, error } = await this.alice.sendMulti({
			messages: [{
				app: 'system_vote',
				payload: {
					subject: 'op_list',
					value: this.emergencyOpAddresses,
				}
			}],
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
	//	console.log(unitObj)
	//	await this.network.witnessUntilStable(unit)
	})
	
	it('Activate the new OPs in emergency', async () => {
		await this.timetravel('2h') // EMERGENCY_COUNT_MIN_VOTE_AGE = 1h
		const balance_before = (await this.alice.getBalance()).base.total
		const { unit, error } = await this.alice.sendMulti({
			messages: [{
				app: 'system_vote_count',
				payload: 'op_list',
			}],
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		// activate the emergency OP list immediately
		this.network.nodes.witnesses = this.new_witnesses
		this.network.initialWitnesses = this.emergencyOpAddresses

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
		console.log(unitObj)
		const balance_after = (await this.alice.getBalance()).base.total
		expect(balance_after).to.be.eq(balance_before - 1e9 - unitObj.headers_commission - unitObj.payload_commission - unitObj.tps_fee);
		await this.network.witnessUntilStable(unit)
	})

	it('Trigger AA again under emergency-activated OPs', async () => {
		const { unit, error } = await this.network.wallet.alice.triggerAaWithData({
			toAddress: this.network.agent.simpleAgent,
			amount: 10000,
			data: {
				a: 100,
				b: 200
			}
		})
		console.log(error)
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: unit })
		console.log(unitObj)

		const { response } = await this.network.getAaResponseToUnitOnNode(this.network.wallet.alice, unit)
		expect(response.response.responseVars.result).to.be.equal(300)
	})


	after(async () => {
		await this.network.stop()
	})
})
