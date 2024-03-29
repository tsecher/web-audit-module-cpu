import {AbstractPuppeteerJourneyModule} from 'web_audit/dist/journey/AbstractPuppeteerJourneyModule.js';
import {PuppeteerJourneyEvents} from 'web_audit/dist/journey/AbstractPuppeteerJourney.js';
import {ModuleEvents} from 'web_audit/dist/modules/ModuleInterface.js';

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

const globalMetrics = {
	'Timestamp': 'Time',
	'LayoutDuration': 'Layout Duration (Display)',
	'RecalcStyleDuration': 'Recalc Style Duration (Render)',
	'DevToolsCommandDuration': 'Dev Tools Command Duration',
	'ScriptDuration': 'Script Duration (Script)',
	'V8CompileDuration': 'V8 Compile Duration',
	'TaskOtherDuration': 'Task Other Duration',
	'TaskDuration': 'Task Duration',
	'TaskDurationWithoutDevTools': 'Task Duration without dev tools',
	'ThreadTime': 'Thread time',
	'ProcessTime': 'Process time',
}

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

	/**
	 * {@inheritdoc}
	 */
	async init(context) {
		this.context = context;

		// Install assets cpu store.
		this.context.config.storage?.installStore('cpu', this.context, {
			...{
				url: 'Url',
				context: 'Context',
			},
			...globalMetrics
		});

		this.context?.config.storage?.installStore('cpu_history', this.context, {
			...{
				url: 'Url',
				time: 'Time',
				step: 'Step',
				context: 'Context',
			},
			...durationMetrics
		});

		// Emit.
		this.context.eventBus.emit(CpuModuleEvents.createCpuModule, {module: this});
	}

	/**
	 * {@inheritdoc}
	 */
	initEvents(journey) {
		journey.on(PuppeteerJourneyEvents.JOURNEY_START, async (data) => this.startMeasure(data.wrapper));
		journey.on(PuppeteerJourneyEvents.JOURNEY_BEFORE_STEP, async (data) => {
			this.unpauseMeasure();
			this.contextsData.step = data.name;
		});
		journey.on(PuppeteerJourneyEvents.JOURNEY_NEW_CONTEXT, async (data) => this.contextsData.context = data.name && this.contexts.push(data.name));
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
		this.context?.eventBus.emit(CpuModuleEvents.onResult, {module: this, url: urlWrapper, result: result});
		this.context?.eventBus.emit(CpuModuleEvents.afterAnalyse, {module: this, url: urlWrapper, result: result});
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
}
