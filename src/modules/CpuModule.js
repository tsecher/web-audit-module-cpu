import {AbstractPuppeteerJourneyModule} from 'web_audit/dist/journey/AbstractPuppeteerJourneyModule.js';
import {PuppeteerJourneyEvents} from 'web_audit/dist/journey/AbstractPuppeteerJourney.js';
import {ModuleEvents} from 'web_audit/dist/modules/ModuleInterface.js';
import schema from "./cpu.schema.json" with {type: "json"};

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

const summaryMetrics = Object.keys(schema.structure.cpu.structure)
						.filter(id => !['url', 'context', 'Timestamp'].includes(id)); 

const globalMetrics = Object.keys(schema.structure.cpu_history.structure)
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
		if(this.isHistoryEnabled()){
			return schema;
		}

		const schema2 = JSON.parse(JSON.stringify(schema));
		delete schema2.structure.cpu_history;
		return schema2;	
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

	isHistoryEnabled() {
		return this.context.config?.AppConfig?.config?.cpu?.history === true;
	}

	/**
	 * {@inheritdoc}
	 */
	initEvents(journey) {
		journey.on(PuppeteerJourneyEvents.JOURNEY_START, async (data) => {
			await this.startMeasure(data.wrapper)
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
		} catch (err) {
			this.stopMeasure(true);
			return;
		}

		if(!this.contextsData.context) {
			return;
		}

		const metricsValues = this.getMetricsValues(metrics);
		this.hasValue = true;
		
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

		values.TaskDurationWithoutDevTools = values.TaskDuration - values.DevToolsCommandDuration
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

		const samples = this.getSamples(this.snapshots, this.context.config?.AppConfig?.config?.cpu?.sampling || 100);

		const values = {
			'summary': this.computeCpuAverage(samples),	
		}
		
		if (this.isHistoryEnabled()) {
			values['history'] = this.computeCpuHistory(samples);
		}

		this.unpauseMeasure();
		return values;
	}

	computeCpuHistory(samples) {
		const history = [];

		const firstTIme = samples[0].metrics.Timestamp;

		for (let i = 1; i < samples.length; i++) {
			const prev = samples[i - 1].metrics;
			const curr = samples[i].metrics;

			const deltaTime = curr.Timestamp - prev.Timestamp; // en secondes
			const result = {
				...samples[i],
				time: curr.Timestamp - firstTIme
			}

			Object.values(globalMetrics).forEach(metricId => {
				const deltaMetric = curr[metricId] - prev[metricId];
				result[metricId] = deltaMetric;
				// const percent = deltaTime > 0 ? (deltaMetric / deltaTime) * 100 : 0;
				// result[metricId] = Math.round(percent * 100) / 100;
			});

			this.context?.config?.storage?.add(this, 'cpu_history', this.context, result);

			history.push(result);
		}

		return history;
	}

	computeCpuAverage(samples) {
		const first = samples[0];
		const last = samples.at(-1);

		const firstTime = first.metrics.Timestamp;
		const lastTime = last.metrics.Timestamp;
		const deltaTime = lastTime - firstTime;

		const result = {
			...last,
			'Timestamp': deltaTime,
		}

		Object.values(summaryMetrics).forEach(metricId => {
			if( metricId.includes('_prct')){
				return;
			}

			const deltaMetric = last.metrics[metricId] - first.metrics[metricId];
			result[metricId] = deltaMetric;

			const percent = deltaTime > 0 ? (deltaMetric / deltaTime) * 100 : 0;
			result[metricId + '_prct'] = Math.round(percent * 100) / 100;
		});

		return result;
	}

	getSamples(snapshots, sampling = 100) {
		sampling = sampling / 1000; 
		const samples = [];

		const first =  snapshots[0];
		let time = first.metrics.Timestamp;

		snapshots.forEach(snap => {
			if(snap.metrics.Timestamp - time > sampling){
				time = snap.metrics.Timestamp;
				samples.push(snap);
			}
		});

		samples.push(snapshots.at(-1));

		return samples;
	}
}
