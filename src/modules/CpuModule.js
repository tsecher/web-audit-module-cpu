import {AbstractPuppeteerJourneyModule} from 'web_audit/dist/journey/AbstractPuppeteerJourneyModule.js';
import {PuppeteerJourneyEvents} from 'web_audit/dist/journey/AbstractPuppeteerJourney.js';
import {ModuleEvents} from 'web_audit/dist/modules/ModuleInterface.js';
import schema from "./cpu.schema.json" with {type: "json"};
import { DefaultDeserializer } from 'v8';

/**
 * CPU Module events.
 */
export const CpuModuleEvents = {
	createCpuModule: 'cpu_module__createCpuModule',
	beforeAnalyse: 'cpu_module__beforeAnalyse',
	onResult: 'cpu_module__onResult',
	onResultDetail: 'cpu_module__onResultDetail',
	afterAnalyse: 'cpu_module__afterAnalyse',
};

const durationMetrics = {
	// 'Timestamp',
	// 'AudioHandlers',
	// 'Documents',
	// 'Frames',
	// 'JSEventListeners',
	// 'LayoutObjects',
	// 'MediaKeySessions',
	// 'MediaKeys',
	// 'Nodes',
	// 'Resources',
	// 'ContextLifecycleStateObservers',
	// 'V8PerContextDatas',
	// 'WorkerGlobalScopes',
	// 'UACSSResources',
	// 'RTCPeerConnections',
	// 'ResourceFetchers',
	// 'AdSubframes',
	// 'DetachedScriptStates',
	// 'ArrayBufferContents',
	// 'LayoutCount',
	// 'RecalcStyleCount',
	'LayoutDuration': 'Layout Duration',
	'RecalcStyleDuration': 'Recalc Style Duration',
	'DevToolsCommandDuration': 'Dev Tools Command Duration',
	'ScriptDuration': 'Script Duration',
	'V8CompileDuration': 'V8 Compile Duration',
	'TaskOtherDuration': 'Task Other Duration',
	'TaskDuration': 'Task Duration',
	// 'ThreadTime',
	// 'ProcessTime',
	// 'JSHeapUsedSize',
	// 'JSHeapTotalSize',
	// 'FirstMeaningfulPaint',
	// 'DomContentLoaded',
	// 'NavigationStart',
};

const globalMetrics = Object.keys(schema.structure.cpu_details.structure)
						.filter(id => !['url', 'time', 'step', 'context'].includes(id));



/**
 * CPU.
 */
export default class CpuModule extends AbstractPuppeteerJourneyModule {
	get name() {
		return 'CPU';
	}

	get id() {
		return `cpu`;
	}

	contextsData = {};

	sampleDuration = 0.1;

	contexts = [];


	getSchema() {
		return schema;
	}

	/**
	 * {@inheritdoc}
	 */
	async init(context) {
		this.context = context;

		// Install Page Speed store.
		this.context.config.storage?.installSchema(this, this.context);

		// Emit.
		this.context.eventBus.emit(CpuModuleEvents.createCpuModule, {module: this});
	}

	/**
	 * {@inheritdoc}
	 */
	initEvents(journey) {
		journey.on(PuppeteerJourneyEvents.JOURNEY_START, async (data) => {
			this.startMeasure(data.wrapper)
		});
		journey.on(PuppeteerJourneyEvents.JOURNEY_BEFORE_STEP, async (data) => {
			this.contextsData.step = data.name;
			this.contextsData.url = data.url.url;
			this.unpauseMeasure();
		});
		journey.on(PuppeteerJourneyEvents.JOURNEY_NEW_CONTEXT, async (data) => {
			this.contextsData.context = data.name;
			this.contexts.push(data.name)
		});
		journey.on(PuppeteerJourneyEvents.JOURNEY_END, async () => this.stopMeasure(true));
		journey.on(PuppeteerJourneyEvents.JOURNEY_ERROR, async () => this.stopMeasure(false));
		this.context?.eventBus.on(ModuleEvents.startsComputing, () => this.pauseMeasure());
	}

	/**
	 * Start measure.
	 *
	 * @param wrapper
	 * @returns {Promise<void>}
	 */
	async startMeasure(wrapper) {
		this.hasValue = false;
		this.isPaused = false;
		this.contextsData = {};
		this.snapshots = [];

		this.cdp = await wrapper.page.target().createCDPSession();
		this.cdp.send('Performance.enable', {
			timeDomain: 'timeTicks',
		});

		this.launchMeasure()
	}

	/**
	 * Launch measure request.
	 *
	 * @returns {Promise<void>}
	 */
	async launchMeasure() {
		if (!this.isPaused) {
			await this.addMetrics();
			if (!this.isPaused) {
				await this.launchMeasure();
			}
		}
	}

	/**
	 * Stop measure.
	 *
	 * @param hasValue
	 */
	stopMeasure(hasValue) {
		this.hasValue = hasValue;
		this.isPaused = true;
	}

	/**
	 * Pause measure.
	 */
	pauseMeasure() {
		this.isPaused = true;
	}

	/**
	 * Unpause measure.
	 *
	 * @returns {Promise<void>}
	 */
	async unpauseMeasure() {
		this.isPaused = false;
		this.launchMeasure();
	}

	/**
	 * Add metrics to sapshots.
	 *
	 * @returns {Promise<void>}
	 */
	async addMetrics() {
		let metrics;
		try {
			metrics = await this.cdp.send('Performance.getMetrics');
			this.hasValue = true;
		} catch (err) {
			this.stopMeasure(true);
			return;
		}

		const metricsValues = this.getMetricsValues(metrics);
		if (metricsValues && !this.isPaused) {
			this.snapshots.push({
				context: this.contextsData.context || '',
				step: this.contextsData.step || '',
				url: this.contextsData.url || '',
				metrics: metricsValues,
			})
		}
	}

	/**
	 * Return the metric value.
	 *
	 * @param metrics
	 * @returns {{}}
	 */
	getMetricsValues(metrics) {
		const values = {};
		metrics.metrics
			.forEach((item) => {
				values[item.name] = item.value;
			});
		return values;
	}

	/**
	 * {@inheritdoc}
	 */
	async analyse(urlWrapper) {
		this.pauseMeasure();

		if (!this.hasValue) {
			return Promise.resolve(false);
		}
		this.context?.eventBus.emit(CpuModuleEvents.beforeAnalyse, {module: this, url: urlWrapper});
		this.context?.eventBus.emit(ModuleEvents.beforeAnalyse, {module: this, url: urlWrapper});

		const result = this.getResult(urlWrapper);


		this.context?.config?.logger.result(`CPU`, result.summary, urlWrapper.url.toString());
		this.context?.eventBus.emit(ModuleEvents.onAnalyseSummary, {module: this, group_id:`cpu` , url: urlWrapper, summary: result.summary});
		this.context?.config?.storage?.add(this, 'cpu', this.context, result.summary);

		this.context?.eventBus.emit(CpuModuleEvents.onResult, {module: this, url: urlWrapper, result: result.summary});
		this.context?.eventBus.emit(CpuModuleEvents.afterAnalyse, {module: this, url: urlWrapper, result: result.summary});
		this.context?.eventBus.emit(ModuleEvents.afterAnalyse, {module: this, url: urlWrapper});

		return Promise.resolve(result?.success || false);
	}


	/**
	 * Return the result.
	 *
	 * @param {UrlWrapper} urlWrapper
	 * @returns {any}
	 * @private
	 */
	getResult(urlWrapper) {
		this.snapshots.sort((snapA, snapB) => snapA.metrics.Timestamp - snapB.metrics.Timestamp);

		const history = this.computeCpuHistory(this.snapshots);

		return {
			'summary': {},
			'details': history,
		}
		

		// Samples data.
		const samples = this.getSampleData(this.snapshots);

		// Log samples data.
		samples
			.forEach((sample) => {
				const item = {
					...{
						url: urlWrapper.url,
						time: sample.timestamp,
						context: sample.context,
						step: sample.step,
					},
					...this.getSnapshotData(sample.average)
				};

				this.context?.config?.storage?.add('cpu_history', this.context, item);
			});

		// Global data.
		const global = this.getGlobalData(this.snapshots, urlWrapper.url.toString(), samples[samples.length - 1].context);

		this.context?.config?.storage?.add('cpu', this.context, global);
		this.context?.config?.logger.result('CPU', global, urlWrapper.url.toString());

		this.unpauseMeasure();
		return true;
	}

	/**
	 * Return snappshot usage value.
	 *
	 * @param {CPUUsageSnapshot} snapshot
	 * @returns {{}}
	 * @private
	 */
	getSnapshotData(snapshot) {
		let durationData = {};

		Object.keys(durationMetrics).forEach((metricName) => {
			if (snapshot && typeof snapshot[metricName] !== "undefined" && !isNaN(snapshot[metricName])) {
				durationData[metricName] = snapshot[metricName];
			}
		});

		return durationData;
	}

	/**
	 * Sample snaphsot data.
	 *
	 * @param snapshots
	 * @returns {unknown[]}
	 */
	getSampleData(snapshots) {
		const firstTimeStamp = snapshots[0].metrics.Timestamp;

		// Sample snapshots.
		let samples = {};
		const sampleRatio = 1 / this.sampleDuration;
		snapshots.forEach((snapshot) => {
			const index = Math.floor(sampleRatio * (snapshot.metrics.Timestamp - firstTimeStamp)) / sampleRatio;
			samples[`index_${index}`] = samples[`index_${index}`] || {
				timestamp: index,
				context: snapshot.context,
				step: snapshot.step,
				snapshots: []
			};
			samples[`index_${index}`].snapshots.push(snapshot);
		});

		samples = Object.values(samples);

		const unique = (value, index, array) => array.indexOf(value) === index;
		const contextsList = samples.map(item => item.context).filter(unique);

		// Get derivative.
		samples.map(sample => {
			sample.snapshots = this.getDerivative(sample.snapshots);
			sample.average = this.getAverageData(sample.snapshots);

			// Reaffect correct context.
			let realContext = contextsList.indexOf(sample.context) > -1 ? contextsList.indexOf(sample.context) : this.contexts.length - 1;
			sample.context = this.contexts[realContext];


			return sample;
		});

		// Sort context.

		return samples;
	}

	/**
	 * Return average data for the snapshots list.
	 *
	 * @param snapshots
	 * @returns {{}}
	 */
	getAverageData(snapshots) {
		const average = {}
		Object.keys(durationMetrics).forEach(metricName => {
			average[metricName] = snapshots.reduce((sum, currentValue) => {
				if (currentValue && typeof currentValue?.metrics[metricName] !== 'undefined' && !isNaN(currentValue?.metrics[metricName])) {
					return sum + currentValue?.metrics[metricName];
				}
				return sum || 0;
			}, 0) / snapshots.length;
		});

		return average;
	}

	/**
	 * Return snapshots derivative.
	 *
	 * @param snapshots
	 * @returns {*}
	 */
	getDerivative(snapshots) {
		const derivative = [];
		for (let i = snapshots.length - 1; i > 0; i--) {
			Object.keys(durationMetrics).forEach(metricName => {
				derivative[i] = derivative[i] || {metrics: {}};
				derivative[i].metrics[metricName] = snapshots[i].metrics[metricName] - snapshots[i - 1].metrics[metricName];
			})
		}

		return derivative;
	}

	getGlobalData(snapshots, url, context) {
		const firstSnapshot = snapshots[0];
		const lastSnapshot = snapshots[snapshots.length - 1];
		const global = {
			url: url,
			context: context,
		}

		Object.keys(globalMetrics).forEach(key => {
			global[key] = lastSnapshot.metrics[key] - firstSnapshot.metrics[key];
		})

		// Calculate task duration without dev tools.
		global.TaskDurationWithoutDevTools = Object.keys(globalMetrics)
			.filter(item => item.indexOf('Duration') > -1 && item.indexOf('DevTools') < 0 && item !== 'TaskDuration')
			.reduce((cumul, key) => {
				return cumul + global[key];
			}, 0);

		return global;
	}


	computeCpuHistory(samples) {
		const history = [];

		for (let i = 1; i < samples.length; i++) {
			const prev = samples[i - 1].metrics;
			const curr = samples[i].metrics;

			const deltaTime = curr.Timestamp - prev.Timestamp; // en secondes

			
			const result = {
				...samples[i],
				time: curr.Timestamp
			}


			// const deltaTask = curr.TaskDuration - prev.TaskDuration; // en secondes CPU

			// const cpuPercent = deltaTime > 0 ? (deltaTask / deltaTime) * 100 : 0;

			// history.push({
			// timestamp: curr.Timestamp,
			// step: curr.step,
			// cpuPercent: Math.round(cpuPercent * 100) / 100, // arrondi à 2 décimales
			// });


			Object.values(globalMetrics).forEach(metricId => {
				const deltaMetric = curr[metricId] - prev[metricId];
				const percent = deltaTime > 0 ? (deltaMetric / deltaTime) * 100 : 0;
				result[metricId] = Math.round(percent * 100) / 100;
			});

			this.context?.config?.storage?.add(this, 'cpu_details', this.context, result);

			history.push(result);
		}

		return history;
	}
}
