import {
	DEFAULT_NEW_WORKFLOW_NAME,
	DUPLICATE_POSTFFIX,
	EnterpriseEditionFeature,
	ERROR_TRIGGER_NODE_TYPE,
	MAX_WORKFLOW_NAME_LENGTH,
	PLACEHOLDER_EMPTY_WORKFLOW_ID,
	START_NODE_TYPE,
	STORES,
} from '@/constants';
import type {
	ExecutionsQueryFilter,
	IExecutionDeleteFilter,
	IExecutionPushResponse,
	IExecutionResponse,
	IExecutionsCurrentSummaryExtended,
	IExecutionsListResponse,
	IExecutionsStopData,
	INewWorkflowData,
	INodeMetadata,
	INodeUi,
	INodeUpdatePropertiesInformation,
	IPushDataExecutionFinished,
	IPushDataNodeExecuteAfter,
	IPushDataUnsavedExecutionFinished,
	IStartRunData,
	IUpdateInformation,
	IUsedCredential,
	IUser,
	IWorkflowDataUpdate,
	IWorkflowDb,
	IWorkflowsMap,
	WorkflowsState,
	NodeMetadataMap,
	WorkflowMetadata,
} from '@/Interface';
import { defineStore } from 'pinia';
import type {
	IAbstractEventMessage,
	IConnection,
	IConnections,
	IDataObject,
	IExecutionsSummary,
	INode,
	INodeConnections,
	INodeCredentials,
	INodeCredentialsDetails,
	INodeExecutionData,
	INodeIssueData,
	INodeIssueObjectProperty,
	INodeParameters,
	INodeTypeData,
	INodeTypes,
	IPinData,
	IRun,
	IRunData,
	IRunExecutionData,
	ITaskData,
	IWorkflowSettings,
} from 'n8n-workflow';
import { deepCopy, NodeHelpers, Workflow } from 'n8n-workflow';
import { findLast } from 'lodash-es';

import { useRootStore } from '@/stores/n8nRoot.store';
import {
	getActiveWorkflows,
	getActiveExecutions,
	getExecutionData,
	getExecutions,
	getNewWorkflow,
	getWorkflow,
	getWorkflows,
} from '@/api/workflows';
import { useUIStore } from '@/stores/ui.store';
import { dataPinningEventBus } from '@/event-bus';
import { isObject } from '@/utils/objectUtils';
import { getPairedItemsMapping } from '@/utils/pairedItemUtils';
import { isJsonKeyObject, isEmpty, stringSizeInBytes } from '@/utils/typesUtils';
import { makeRestApiRequest, unflattenExecutionData } from '@/utils/apiUtils';
import { useNDVStore } from '@/stores/ndv.store';
import { useNodeTypesStore } from '@/stores/nodeTypes.store';
import { useUsersStore } from '@/stores/users.store';
import { useSettingsStore } from '@/stores/settings.store';
import { getCredentialOnlyNodeTypeName } from '@/utils/credentialOnlyNodes';

const defaults: Omit<IWorkflowDb, 'id'> & { settings: NonNullable<IWorkflowDb['settings']> } = {
	name: '',
	active: false,
	createdAt: -1,
	updatedAt: -1,
	connections: {},
	nodes: [],
	settings: {
		executionOrder: 'v1',
	},
	tags: [],
	pinData: {},
	versionId: '',
	usedCredentials: [],
};

const createEmptyWorkflow = (): IWorkflowDb => ({
	id: PLACEHOLDER_EMPTY_WORKFLOW_ID,
	...defaults,
});

let cachedWorkflowKey: string | null = '';
let cachedWorkflow: Workflow | null = null;

export const useWorkflowsStore = defineStore(STORES.WORKFLOWS, {
	state: (): WorkflowsState => ({
		workflow: createEmptyWorkflow(),
		usedCredentials: {},
		activeWorkflows: [],
		activeExecutions: [],
		currentWorkflowExecutions: [],
		activeWorkflowExecution: null,
		finishedExecutionsCount: 0,
		workflowExecutionData: null,
		workflowExecutionPairedItemMappings: {},
		workflowsById: {},
		subWorkflowExecutionError: null,
		activeExecutionId: null,
		executingNode: [],
		executionWaitingForWebhook: false,
		nodeMetadata: {},
		isInDebugMode: false,
	}),
	getters: {
		// Workflow getters
		workflowName(): string {
			return this.workflow.name;
		},
		workflowId(): string {
			return this.workflow.id;
		},
		workflowVersionId(): string | undefined {
			return this.workflow.versionId;
		},
		workflowSettings(): IWorkflowSettings {
			return this.workflow.settings ?? { ...defaults.settings };
		},
		workflowTags(): string[] {
			return this.workflow.tags as string[];
		},
		allWorkflows(): IWorkflowDb[] {
			return Object.values(this.workflowsById).sort((a, b) => a.name.localeCompare(b.name));
		},
		isNewWorkflow(): boolean {
			return this.workflow.id === PLACEHOLDER_EMPTY_WORKFLOW_ID;
		},
		isWorkflowActive(): boolean {
			return this.workflow.active;
		},
		workflowTriggerNodes(): INodeUi[] {
			return this.workflow.nodes.filter((node: INodeUi) => {
				const nodeTypesStore = useNodeTypesStore();
				const nodeType = nodeTypesStore.getNodeType(node.type, node.typeVersion);
				return nodeType && nodeType.group.includes('trigger');
			});
		},
		currentWorkflowHasWebhookNode(): boolean {
			return !!this.workflow.nodes.find((node: INodeUi) => !!node.webhookId); // includes Wait node
		},
		getWorkflowRunData(): IRunData | null {
			if (!this.workflowExecutionData?.data?.resultData) {
				return null;
			}
			return this.workflowExecutionData.data.resultData.runData;
		},
		getWorkflowResultDataByNodeName() {
			return (nodeName: string): ITaskData[] | null => {
				const workflowRunData = this.getWorkflowRunData;

				if (workflowRunData === null) {
					return null;
				}
				if (!workflowRunData.hasOwnProperty(nodeName)) {
					return null;
				}
				return workflowRunData[nodeName];
			};
		},
		getWorkflowById() {
			return (id: string): IWorkflowDb => this.workflowsById[id];
		},

		// Node getters
		allConnections(): IConnections {
			return this.workflow.connections;
		},
		outgoingConnectionsByNodeName() {
			return (nodeName: string): INodeConnections => {
				if (this.workflow.connections.hasOwnProperty(nodeName)) {
					return this.workflow.connections[nodeName];
				}
				return {};
			};
		},
		isNodeInOutgoingNodeConnections() {
			return (firstNode: string, secondNode: string): boolean => {
				const firstNodeConnections = this.outgoingConnectionsByNodeName(firstNode);
				if (!firstNodeConnections?.main?.[0]) return false;
				const connections = firstNodeConnections.main[0];
				if (connections.some((node) => node.node === secondNode)) return true;
				return connections.some((node) =>
					this.isNodeInOutgoingNodeConnections(node.node, secondNode),
				);
			};
		},
		allNodes(): INodeUi[] {
			return this.workflow.nodes;
		},
		/**
		 * Names of all nodes currently on canvas.
		 */
		canvasNames(): Set<string> {
			return new Set(this.allNodes.map((n) => n.name));
		},
		nodesByName(): { [name: string]: INodeUi } {
			return this.workflow.nodes.reduce((accu: { [name: string]: INodeUi }, node) => {
				accu[node.name] = node;
				return accu;
			}, {});
		},
		getNodeByName() {
			return (nodeName: string): INodeUi | null => this.nodesByName[nodeName] || null;
		},
		getNodeById() {
			return (nodeId: string): INodeUi | undefined =>
				this.workflow.nodes.find((node: INodeUi) => {
					return node.id === nodeId;
				});
		},
		nodesIssuesExist(): boolean {
			for (const node of this.workflow.nodes) {
				if (node.issues === undefined || Object.keys(node.issues).length === 0) {
					continue;
				}
				return true;
			}
			return false;
		},
		pinnedWorkflowData(): IPinData | undefined {
			return this.workflow.pinData;
		},
		shouldReplaceInputDataWithPinData(): boolean {
			return !this.activeWorkflowExecution || this.activeWorkflowExecution?.mode === 'manual';
		},
		executedNode(): string | undefined {
			return this.workflowExecutionData ? this.workflowExecutionData.executedNode : undefined;
		},
		getParametersLastUpdate(): (name: string) => number | undefined {
			return (nodeName: string) => this.nodeMetadata[nodeName]?.parametersLastUpdatedAt;
		},

		isNodePristine(): (name: string) => boolean {
			return (nodeName: string) =>
				this.nodeMetadata[nodeName] === undefined || this.nodeMetadata[nodeName].pristine;
		},
		isNodeExecuting(): (nodeName: string) => boolean {
			return (nodeName: string) => this.executingNode.includes(nodeName);
		},
		// Executions getters
		getExecutionDataById(): (id: string) => IExecutionsSummary | undefined {
			return (id: string): IExecutionsSummary | undefined =>
				this.currentWorkflowExecutions.find((execution) => execution.id === id);
		},
		getAllLoadedFinishedExecutions(): IExecutionsSummary[] {
			return this.currentWorkflowExecutions.filter(
				(ex) => ex.finished === true || ex.stoppedAt !== undefined,
			);
		},
		getWorkflowExecution(): IExecutionResponse | null {
			return this.workflowExecutionData;
		},
		getTotalFinishedExecutionsCount(): number {
			return this.finishedExecutionsCount;
		},
	},
	actions: {
		getPinDataSize(pinData: Record<string, string | INodeExecutionData[]> = {}): number {
			return Object.values(pinData).reduce<number>((acc, value) => {
				return acc + stringSizeInBytes(value);
			}, 0);
		},
		getNodeTypes(): INodeTypes {
			const nodeTypes: INodeTypes = {
				nodeTypes: {},
				init: async (nodeTypes?: INodeTypeData): Promise<void> => {},
				// @ts-ignore
				getByNameAndVersion: (nodeType: string, version?: number): INodeType | undefined => {
					const nodeTypeDescription = useNodeTypesStore().getNodeType(nodeType, version);

					if (nodeTypeDescription === null) {
						return undefined;
					}

					return {
						description: nodeTypeDescription,
						// As we do not have the trigger/poll functions available in the frontend
						// we use the information available to figure out what are trigger nodes
						// @ts-ignore
						trigger:
							(![ERROR_TRIGGER_NODE_TYPE, START_NODE_TYPE].includes(nodeType) &&
								nodeTypeDescription.inputs.length === 0 &&
								!nodeTypeDescription.webhooks) ||
							undefined,
					};
				},
			};

			return nodeTypes;
		},

		// Returns a shallow copy of the nodes which means that all the data on the lower
		// levels still only gets referenced but the top level object is a different one.
		// This has the advantage that it is very fast and does not cause problems with vuex
		// when the workflow replaces the node-parameters.
		getNodes(): INodeUi[] {
			const nodes = this.allNodes;
			const returnNodes: INodeUi[] = [];

			for (const node of nodes) {
				returnNodes.push(Object.assign({}, node));
			}

			return returnNodes;
		},

		// Returns a workflow instance.
		getWorkflow(nodes: INodeUi[], connections: IConnections, copyData?: boolean): Workflow {
			const nodeTypes = this.getNodeTypes();
			let workflowId: string | undefined = this.workflowId;
			if (workflowId && workflowId === PLACEHOLDER_EMPTY_WORKFLOW_ID) {
				workflowId = undefined;
			}

			cachedWorkflow = new Workflow({
				id: workflowId,
				name: this.workflowName,
				nodes: copyData ? deepCopy(nodes) : nodes,
				connections: copyData ? deepCopy(connections) : connections,
				active: false,
				nodeTypes,
				settings: this.workflowSettings,
				// @ts-ignore
				pinData: this.pinnedWorkflowData,
			});

			return cachedWorkflow;
		},

		getCurrentWorkflow(copyData?: boolean): Workflow {
			const nodes = this.getNodes();
			const connections = this.allConnections;
			const cacheKey = JSON.stringify({ nodes, connections });
			if (!copyData && cachedWorkflow && cacheKey === cachedWorkflowKey) {
				return cachedWorkflow;
			}
			cachedWorkflowKey = cacheKey;

			return this.getWorkflow(nodes, connections, copyData);
		},

		// Returns a workflow from a given URL
		async getWorkflowFromUrl(url: string): Promise<IWorkflowDb> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(rootStore.getRestApiContext, 'GET', '/workflows/from-url', {
				url,
			});
		},

		async getActivationError(id: string): Promise<string | undefined> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'GET',
				`/active-workflows/error/${id}`,
			);
		},

		async fetchAllWorkflows(): Promise<IWorkflowDb[]> {
			const rootStore = useRootStore();
			const workflows = await getWorkflows(rootStore.getRestApiContext);
			this.setWorkflows(workflows);
			return workflows;
		},

		async fetchWorkflow(id: string): Promise<IWorkflowDb> {
			const rootStore = useRootStore();
			const workflow = await getWorkflow(rootStore.getRestApiContext, id);
			this.addWorkflow(workflow);
			return workflow;
		},

		async getNewWorkflowData(name?: string): Promise<INewWorkflowData> {
			let workflowData = {
				name: '',
				onboardingFlowEnabled: false,
				settings: { ...defaults.settings },
			};
			try {
				const rootStore = useRootStore();
				workflowData = await getNewWorkflow(rootStore.getRestApiContext, name);
			} catch (e) {
				// in case of error, default to original name
				workflowData.name = name || DEFAULT_NEW_WORKFLOW_NAME;
			}

			this.setWorkflowName({ newName: workflowData.name, setStateDirty: false });

			return workflowData;
		},

		resetWorkflow() {
			const usersStore = useUsersStore();
			const settingsStore = useSettingsStore();

			this.workflow = createEmptyWorkflow();

			if (settingsStore.isEnterpriseFeatureEnabled(EnterpriseEditionFeature.Sharing)) {
				this.workflow = {
					...this.workflow,
					ownedBy: usersStore.currentUser as IUser,
				};
			}
		},

		resetState(): void {
			this.removeAllConnections({ setStateDirty: false });
			this.removeAllNodes({ setStateDirty: false, removePinData: true });

			// Reset workflow execution data
			this.setWorkflowExecutionData(null);
			this.resetAllNodesIssues();

			this.setActive(defaults.active);
			this.setWorkflowId(PLACEHOLDER_EMPTY_WORKFLOW_ID);
			this.setWorkflowName({ newName: '', setStateDirty: false });
			this.setWorkflowSettings({ ...defaults.settings });
			this.setWorkflowTagIds([]);

			this.activeExecutionId = null;
			this.executingNode.length = 0;
			this.executionWaitingForWebhook = false;
		},

		addExecutingNode(nodeName: string): void {
			this.executingNode.push(nodeName);
		},

		removeExecutingNode(nodeName: string): void {
			this.executingNode = this.executingNode.filter((name) => name !== nodeName);
		},

		setWorkflowId(id: string): void {
			this.workflow.id = id === 'new' ? PLACEHOLDER_EMPTY_WORKFLOW_ID : id;
		},

		setUsedCredentials(data: IUsedCredential[]) {
			this.workflow.usedCredentials = data;
			this.usedCredentials = data.reduce<{ [name: string]: IUsedCredential }>(
				(accu, credential) => {
					accu[credential.id] = credential;
					return accu;
				},
				{},
			);
		},

		setWorkflowName(data: { newName: string; setStateDirty: boolean }): void {
			if (data.setStateDirty) {
				const uiStore = useUIStore();
				uiStore.stateIsDirty = true;
			}
			this.workflow.name = data.newName;

			if (
				this.workflow.id !== PLACEHOLDER_EMPTY_WORKFLOW_ID &&
				this.workflowsById[this.workflow.id]
			) {
				this.workflowsById[this.workflow.id].name = data.newName;
			}
		},

		setWorkflowVersionId(versionId: string): void {
			this.workflow.versionId = versionId;
		},

		// replace invalid credentials in workflow
		replaceInvalidWorkflowCredentials(data: {
			credentials: INodeCredentialsDetails;
			invalid: INodeCredentialsDetails;
			type: string;
		}): void {
			this.workflow.nodes.forEach((node: INodeUi) => {
				const nodeCredentials: INodeCredentials | undefined = (node as unknown as INode)
					.credentials;

				if (!nodeCredentials?.[data.type]) {
					return;
				}

				const nodeCredentialDetails: INodeCredentialsDetails | string = nodeCredentials[data.type];

				if (
					typeof nodeCredentialDetails === 'string' &&
					nodeCredentialDetails === data.invalid.name
				) {
					(node.credentials as INodeCredentials)[data.type] = data.credentials;
					return;
				}

				if (nodeCredentialDetails.id === null) {
					if (nodeCredentialDetails.name === data.invalid.name) {
						(node.credentials as INodeCredentials)[data.type] = data.credentials;
					}
					return;
				}

				if (nodeCredentialDetails.id === data.invalid.id) {
					(node.credentials as INodeCredentials)[data.type] = data.credentials;
				}
			});
		},

		setWorkflows(workflows: IWorkflowDb[]): void {
			this.workflowsById = workflows.reduce<IWorkflowsMap>((acc, workflow: IWorkflowDb) => {
				if (workflow.id) {
					acc[workflow.id] = workflow;
				}

				return acc;
			}, {});
		},

		async deleteWorkflow(id: string): Promise<void> {
			const rootStore = useRootStore();
			await makeRestApiRequest(rootStore.getRestApiContext, 'DELETE', `/workflows/${id}`);
			const { [id]: deletedWorkflow, ...workflows } = this.workflowsById;
			this.workflowsById = workflows;
		},

		addWorkflow(workflow: IWorkflowDb): void {
			this.workflowsById = {
				...this.workflowsById,
				[workflow.id]: {
					...this.workflowsById[workflow.id],
					...deepCopy(workflow),
				},
			};
		},

		setWorkflowActive(workflowId: string): void {
			const uiStore = useUIStore();
			uiStore.stateIsDirty = false;
			const index = this.activeWorkflows.indexOf(workflowId);
			if (index === -1) {
				this.activeWorkflows.push(workflowId);
			}
			if (this.workflowsById[workflowId]) {
				this.workflowsById[workflowId].active = true;
			}
			if (workflowId === this.workflow.id) {
				this.setActive(true);
			}
		},

		setWorkflowInactive(workflowId: string): void {
			const index = this.activeWorkflows.indexOf(workflowId);
			if (index !== -1) {
				this.activeWorkflows.splice(index, 1);
			}
			if (this.workflowsById[workflowId]) {
				this.workflowsById[workflowId].active = false;
			}
			if (workflowId === this.workflow.id) {
				this.setActive(false);
			}
		},

		async fetchActiveWorkflows(): Promise<string[]> {
			const rootStore = useRootStore();
			const activeWorkflows = await getActiveWorkflows(rootStore.getRestApiContext);
			this.activeWorkflows = activeWorkflows;
			return activeWorkflows;
		},

		setActive(newActive: boolean): void {
			this.workflow.active = newActive;
		},

		async getDuplicateCurrentWorkflowName(currentWorkflowName: string): Promise<string> {
			if (
				currentWorkflowName &&
				currentWorkflowName.length + DUPLICATE_POSTFFIX.length >= MAX_WORKFLOW_NAME_LENGTH
			) {
				return currentWorkflowName;
			}

			let newName = `${currentWorkflowName}${DUPLICATE_POSTFFIX}`;
			try {
				const rootStore = useRootStore();
				const newWorkflow = await getNewWorkflow(rootStore.getRestApiContext, newName);
				newName = newWorkflow.name;
			} catch (e) {}
			return newName;
		},

		// Node actions
		setWorkflowExecutionData(workflowResultData: IExecutionResponse | null): void {
			this.workflowExecutionData = workflowResultData;
			this.workflowExecutionPairedItemMappings = getPairedItemsMapping(this.workflowExecutionData);
		},

		setWorkflowExecutionRunData(workflowResultData: IRunExecutionData): void {
			if (this.workflowExecutionData) this.workflowExecutionData.data = workflowResultData;
		},

		setWorkflowSettings(workflowSettings: IWorkflowSettings): void {
			this.workflow = {
				...this.workflow,
				settings: workflowSettings as IWorkflowDb['settings'],
			};
		},

		setWorkflowPinData(pinData: IPinData): void {
			this.workflow = {
				...this.workflow,
				pinData: pinData || {},
			};
			dataPinningEventBus.emit('pin-data', pinData || {});
		},

		setWorkflowTagIds(tags: string[]): void {
			this.workflow = {
				...this.workflow,
				tags,
			};
		},

		addWorkflowTagIds(tags: string[]): void {
			this.workflow = {
				...this.workflow,
				tags: [...new Set([...(this.workflow.tags || []), ...tags])] as IWorkflowDb['tags'],
			};
		},

		removeWorkflowTagId(tagId: string): void {
			const tags = this.workflow.tags as string[];
			const updated = tags.filter((id: string) => id !== tagId);
			this.workflow = {
				...this.workflow,
				tags: updated as IWorkflowDb['tags'],
			};
		},

		setWorkflowMetadata(metadata: WorkflowMetadata | undefined): void {
			this.workflow.meta = metadata;
		},

		addToWorkflowMetadata(data: Partial<WorkflowMetadata>): void {
			this.workflow.meta = {
				...this.workflow.meta,
				...data,
			};
		},

		setWorkflow(workflow: IWorkflowDb): void {
			this.workflow = workflow;
			this.workflow = {
				...this.workflow,
				...(!this.workflow.hasOwnProperty('active') ? { active: false } : {}),
				...(!this.workflow.hasOwnProperty('connections') ? { connections: {} } : {}),
				...(!this.workflow.hasOwnProperty('createdAt') ? { createdAt: -1 } : {}),
				...(!this.workflow.hasOwnProperty('updatedAt') ? { updatedAt: -1 } : {}),
				...(!this.workflow.hasOwnProperty('id') ? { id: PLACEHOLDER_EMPTY_WORKFLOW_ID } : {}),
				...(!this.workflow.hasOwnProperty('nodes') ? { nodes: [] } : {}),
				...(!this.workflow.hasOwnProperty('settings')
					? { settings: { ...defaults.settings } }
					: {}),
			};
		},

		pinData(payload: { node: INodeUi; data: INodeExecutionData[] }): void {
			if (!this.workflow.pinData) {
				this.workflow = { ...this.workflow, pinData: {} };
			}

			if (!Array.isArray(payload.data)) {
				payload.data = [payload.data];
			}

			const storedPinData = payload.data.map((item) =>
				isJsonKeyObject(item) ? { json: item.json } : { json: item },
			);

			this.workflow = {
				...this.workflow,
				pinData: {
					...this.workflow.pinData,
					[payload.node.name]: storedPinData,
				},
			};

			const uiStore = useUIStore();
			uiStore.stateIsDirty = true;

			dataPinningEventBus.emit('pin-data', { [payload.node.name]: storedPinData });
		},

		unpinData(payload: { node: INodeUi }): void {
			if (!this.workflow.pinData) {
				this.workflow = { ...this.workflow, pinData: {} };
			}

			const { [payload.node.name]: _, ...pinData } = this.workflow.pinData!;
			this.workflow = {
				...this.workflow,
				pinData,
			};

			const uiStore = useUIStore();
			uiStore.stateIsDirty = true;

			dataPinningEventBus.emit('unpin-data', { [payload.node.name]: undefined });
		},

		addConnection(data: { connection: IConnection[] }): void {
			if (data.connection.length !== 2) {
				// All connections need two entries
				// TODO: Check if there is an error or whatever that is supposed to be returned
				return;
			}
			const sourceData: IConnection = data.connection[0];
			const destinationData: IConnection = data.connection[1];

			// Check if source node and type exist already and if not add them
			if (!this.workflow.connections.hasOwnProperty(sourceData.node)) {
				this.workflow = {
					...this.workflow,
					connections: {
						...this.workflow.connections,
						[sourceData.node]: {},
					},
				};
			}
			if (!this.workflow.connections[sourceData.node].hasOwnProperty(sourceData.type)) {
				this.workflow = {
					...this.workflow,
					connections: {
						...this.workflow.connections,
						[sourceData.node]: {
							...this.workflow.connections[sourceData.node],
							[sourceData.type]: [],
						},
					},
				};
			}
			if (
				this.workflow.connections[sourceData.node][sourceData.type].length <
				sourceData.index + 1
			) {
				for (
					let i = this.workflow.connections[sourceData.node][sourceData.type].length;
					i <= sourceData.index;
					i++
				) {
					this.workflow.connections[sourceData.node][sourceData.type].push([]);
				}
			}

			// Check if the same connection exists already
			const checkProperties = ['index', 'node', 'type'] as Array<keyof IConnection>;
			let propertyName: keyof IConnection;
			let connectionExists = false;
			connectionLoop: for (const existingConnection of this.workflow.connections[sourceData.node][
				sourceData.type
			][sourceData.index]) {
				for (propertyName of checkProperties) {
					if (existingConnection[propertyName] !== destinationData[propertyName]) {
						continue connectionLoop;
					}
				}
				connectionExists = true;
				break;
			}
			// Add the new connection if it does not exist already
			if (!connectionExists) {
				this.workflow.connections[sourceData.node][sourceData.type][sourceData.index].push(
					destinationData,
				);
			}
		},

		removeConnection(data: { connection: IConnection[] }): void {
			const sourceData = data.connection[0];
			const destinationData = data.connection[1];

			if (!this.workflow.connections.hasOwnProperty(sourceData.node)) {
				return;
			}
			if (!this.workflow.connections[sourceData.node].hasOwnProperty(sourceData.type)) {
				return;
			}
			if (
				this.workflow.connections[sourceData.node][sourceData.type].length <
				sourceData.index + 1
			) {
				return;
			}
			const uiStore = useUIStore();
			uiStore.stateIsDirty = true;

			const connections =
				this.workflow.connections[sourceData.node][sourceData.type][sourceData.index];
			for (const index in connections) {
				if (
					connections[index].node === destinationData.node &&
					connections[index].type === destinationData.type &&
					connections[index].index === destinationData.index
				) {
					// Found the connection to remove
					connections.splice(parseInt(index, 10), 1);
				}
			}
		},

		removeAllConnections(data: { setStateDirty: boolean }): void {
			if (data && data.setStateDirty) {
				const uiStore = useUIStore();
				uiStore.stateIsDirty = true;
			}
			this.workflow.connections = {};
		},

		removeAllNodeConnection(node: INodeUi): void {
			const uiStore = useUIStore();
			uiStore.stateIsDirty = true;
			// Remove all source connections
			if (this.workflow.connections.hasOwnProperty(node.name)) {
				delete this.workflow.connections[node.name];
			}

			// Remove all destination connections
			const indexesToRemove = [];
			let sourceNode: string,
				type: string,
				sourceIndex: string,
				connectionIndex: string,
				connectionData: IConnection;
			for (sourceNode of Object.keys(this.workflow.connections)) {
				for (type of Object.keys(this.workflow.connections[sourceNode])) {
					for (sourceIndex of Object.keys(this.workflow.connections[sourceNode][type])) {
						indexesToRemove.length = 0;
						for (connectionIndex of Object.keys(
							this.workflow.connections[sourceNode][type][parseInt(sourceIndex, 10)],
						)) {
							connectionData =
								this.workflow.connections[sourceNode][type][parseInt(sourceIndex, 10)][
									parseInt(connectionIndex, 10)
								];
							if (connectionData.node === node.name) {
								indexesToRemove.push(connectionIndex);
							}
						}

						indexesToRemove.forEach((index) => {
							this.workflow.connections[sourceNode][type][parseInt(sourceIndex, 10)].splice(
								parseInt(index, 10),
								1,
							);
						});
					}
				}
			}
		},

		renameNodeSelectedAndExecution(nameData: { old: string; new: string }): void {
			const uiStore = useUIStore();
			uiStore.stateIsDirty = true;
			// If node has any WorkflowResultData rename also that one that the data
			// does still get displayed also after node got renamed
			if (
				this.workflowExecutionData?.data &&
				this.workflowExecutionData.data.resultData.runData.hasOwnProperty(nameData.old)
			) {
				this.workflowExecutionData.data.resultData.runData[nameData.new] =
					this.workflowExecutionData.data.resultData.runData[nameData.old];
				delete this.workflowExecutionData.data.resultData.runData[nameData.old];
			}

			// In case the renamed node was last selected set it also there with the new name
			if (uiStore.lastSelectedNode === nameData.old) {
				uiStore.lastSelectedNode = nameData.new;
			}

			const { [nameData.old]: removed, ...rest } = this.nodeMetadata;
			this.nodeMetadata = { ...rest, [nameData.new]: this.nodeMetadata[nameData.old] };

			if (this.workflow.pinData && this.workflow.pinData.hasOwnProperty(nameData.old)) {
				const { [nameData.old]: renamed, ...restPinData } = this.workflow.pinData;
				this.workflow = {
					...this.workflow,
					pinData: {
						...restPinData,
						[nameData.new]: renamed,
					},
				};
			}
		},

		resetAllNodesIssues(): boolean {
			this.workflow.nodes.forEach((node) => {
				node.issues = undefined;
			});
			return true;
		},

		updateNodeAtIndex(nodeIndex: number, nodeData: Partial<INodeUi>): void {
			if (nodeIndex !== -1) {
				const node = this.workflow.nodes[nodeIndex];
				this.workflow = {
					...this.workflow,
					nodes: [
						...this.workflow.nodes.slice(0, nodeIndex),
						{ ...node, ...nodeData },
						...this.workflow.nodes.slice(nodeIndex + 1),
					],
				};
			}
		},

		setNodeIssue(nodeIssueData: INodeIssueData): boolean {
			const nodeIndex = this.workflow.nodes.findIndex((node) => {
				return node.name === nodeIssueData.node;
			});

			if (nodeIndex === -1) {
				return false;
			}

			const node = this.workflow.nodes[nodeIndex];

			if (nodeIssueData.value === null) {
				// Remove the value if one exists
				if (node.issues?.[nodeIssueData.type] === undefined) {
					// No values for type exist so nothing has to get removed
					return true;
				}

				const { [nodeIssueData.type]: removedNodeIssue, ...remainingNodeIssues } = node.issues;
				this.updateNodeAtIndex(nodeIndex, {
					issues: remainingNodeIssues,
				});
			} else {
				if (node.issues === undefined) {
					this.updateNodeAtIndex(nodeIndex, {
						issues: {},
					});
				}

				this.updateNodeAtIndex(nodeIndex, {
					issues: {
						...node.issues,
						[nodeIssueData.type]: nodeIssueData.value as INodeIssueObjectProperty,
					},
				});
			}
			return true;
		},

		addNode(nodeData: INodeUi): void {
			if (!nodeData.hasOwnProperty('name')) {
				// All nodes have to have a name
				// TODO: Check if there is an error or whatever that is supposed to be returned
				return;
			}

			if (nodeData.extendsCredential) {
				nodeData.type = getCredentialOnlyNodeTypeName(nodeData.extendsCredential);
			}

			this.workflow.nodes.push(nodeData);
			// Init node metadata
			if (!this.nodeMetadata[nodeData.name]) {
				this.nodeMetadata = { ...this.nodeMetadata, [nodeData.name]: {} as INodeMetadata };
			}
		},

		removeNode(node: INodeUi): void {
			const uiStore = useUIStore();
			const { [node.name]: removedNodeMetadata, ...remainingNodeMetadata } = this.nodeMetadata;
			this.nodeMetadata = remainingNodeMetadata;

			if (this.workflow.pinData && this.workflow.pinData.hasOwnProperty(node.name)) {
				const { [node.name]: removedPinData, ...remainingPinData } = this.workflow.pinData;
				this.workflow = {
					...this.workflow,
					pinData: remainingPinData,
				};
			}

			for (let i = 0; i < this.workflow.nodes.length; i++) {
				if (this.workflow.nodes[i].name === node.name) {
					this.workflow = {
						...this.workflow,
						nodes: [...this.workflow.nodes.slice(0, i), ...this.workflow.nodes.slice(i + 1)],
					};

					uiStore.stateIsDirty = true;
					return;
				}
			}
		},

		removeAllNodes(data: { setStateDirty: boolean; removePinData: boolean }): void {
			if (data.setStateDirty) {
				const uiStore = useUIStore();
				uiStore.stateIsDirty = true;
			}

			if (data.removePinData) {
				this.workflow = {
					...this.workflow,
					pinData: {},
				};
			}

			this.workflow.nodes.splice(0, this.workflow.nodes.length);
			this.nodeMetadata = {};
		},

		updateNodeProperties(updateInformation: INodeUpdatePropertiesInformation): void {
			// Find the node that should be updated
			const nodeIndex = this.workflow.nodes.findIndex((node) => {
				return node.name === updateInformation.name;
			});

			if (nodeIndex !== -1) {
				for (const key of Object.keys(updateInformation.properties)) {
					const uiStore = useUIStore();
					uiStore.stateIsDirty = true;

					this.updateNodeAtIndex(nodeIndex, {
						[key]: updateInformation.properties[key],
					});
				}
			}
		},

		setNodeValue(updateInformation: IUpdateInformation): void {
			// Find the node that should be updated
			const nodeIndex = this.workflow.nodes.findIndex((node) => {
				return node.name === updateInformation.name;
			});

			if (nodeIndex === -1 || !updateInformation.key) {
				throw new Error(
					`Node with the name "${updateInformation.name}" could not be found to set parameter.`,
				);
			}

			const uiStore = useUIStore();
			uiStore.stateIsDirty = true;

			this.updateNodeAtIndex(nodeIndex, {
				[updateInformation.key]: updateInformation.value,
			});
		},

		setNodeParameters(updateInformation: IUpdateInformation, append?: boolean): void {
			// Find the node that should be updated
			const nodeIndex = this.workflow.nodes.findIndex((node) => {
				return node.name === updateInformation.name;
			});

			if (nodeIndex === -1) {
				throw new Error(
					`Node with the name "${updateInformation.name}" could not be found to set parameter.`,
				);
			}

			const node = this.workflow.nodes[nodeIndex];

			const uiStore = useUIStore();
			uiStore.stateIsDirty = true;
			const newParameters =
				!!append && isObject(updateInformation.value)
					? { ...node.parameters, ...updateInformation.value }
					: updateInformation.value;

			this.updateNodeAtIndex(nodeIndex, {
				parameters: newParameters as INodeParameters,
			});

			this.nodeMetadata = {
				...this.nodeMetadata,
				[node.name]: {
					...this.nodeMetadata[node.name],
					parametersLastUpdatedAt: Date.now(),
				},
			} as NodeMetadataMap;
		},

		setLastNodeParameters(updateInformation: IUpdateInformation) {
			const latestNode = findLast(
				this.workflow.nodes,
				(node) => node.type === updateInformation.key,
			) as INodeUi;
			const nodeType = useNodeTypesStore().getNodeType(latestNode.type);
			if (!nodeType) return;

			const nodeParams = NodeHelpers.getNodeParameters(
				nodeType.properties,
				updateInformation.value as INodeParameters,
				true,
				false,
				latestNode,
			);

			if (latestNode) this.setNodeParameters({ value: nodeParams, name: latestNode.name }, true);
		},

		addNodeExecutionData(pushData: IPushDataNodeExecuteAfter): void {
			if (!this.workflowExecutionData?.data) {
				throw new Error('The "workflowExecutionData" is not initialized!');
			}
			if (this.workflowExecutionData.data.resultData.runData[pushData.nodeName] === undefined) {
				this.workflowExecutionData = {
					...this.workflowExecutionData,
					data: {
						...this.workflowExecutionData.data,
						resultData: {
							...this.workflowExecutionData.data.resultData,
							runData: {
								...this.workflowExecutionData.data.resultData.runData,
								[pushData.nodeName]: [],
							},
						},
					},
				};
			}
			this.workflowExecutionData.data!.resultData.runData[pushData.nodeName].push(pushData.data);
		},
		clearNodeExecutionData(nodeName: string): void {
			if (!this.workflowExecutionData?.data) {
				return;
			}

			const { [nodeName]: removedRunData, ...remainingRunData } =
				this.workflowExecutionData.data.resultData.runData;
			this.workflowExecutionData = {
				...this.workflowExecutionData,
				data: {
					...this.workflowExecutionData.data,
					resultData: {
						...this.workflowExecutionData.data.resultData,
						runData: remainingRunData,
					},
				},
			};
		},

		pinDataByNodeName(nodeName: string): INodeExecutionData[] | undefined {
			if (!this.workflow.pinData?.[nodeName]) return undefined;

			return this.workflow.pinData[nodeName].map((item) => item.json) as INodeExecutionData[];
		},

		activeNode(): INodeUi | null {
			// kept here for FE hooks
			const ndvStore = useNDVStore();
			return ndvStore.activeNode;
		},

		// Executions actions

		addActiveExecution(newActiveExecution: IExecutionsCurrentSummaryExtended): void {
			// Check if the execution exists already
			const activeExecution = this.activeExecutions.find((execution) => {
				return execution.id === newActiveExecution.id;
			});

			if (activeExecution !== undefined) {
				// Exists already so no need to add it again
				if (activeExecution.workflowName === undefined) {
					activeExecution.workflowName = newActiveExecution.workflowName;
				}
				return;
			}
			this.activeExecutions.unshift(newActiveExecution);
			this.activeExecutionId = newActiveExecution.id;
		},
		finishActiveExecution(
			finishedActiveExecution: IPushDataExecutionFinished | IPushDataUnsavedExecutionFinished,
		): void {
			// Find the execution to set to finished
			const activeExecutionIndex = this.activeExecutions.findIndex((execution) => {
				return execution.id === finishedActiveExecution.executionId;
			});

			if (activeExecutionIndex === -1) {
				// The execution could not be found
				return;
			}

			const activeExecution = this.activeExecutions[activeExecutionIndex];

			this.activeExecutions = [
				...this.activeExecutions.slice(0, activeExecutionIndex),
				{
					...activeExecution,
					...(finishedActiveExecution.executionId !== undefined
						? { id: finishedActiveExecution.executionId }
						: {}),
					finished: finishedActiveExecution.data.finished,
					stoppedAt: finishedActiveExecution.data.stoppedAt,
				},
				...this.activeExecutions.slice(activeExecutionIndex + 1),
			];

			if (finishedActiveExecution.data && (finishedActiveExecution.data as IRun).data) {
				this.setWorkflowExecutionRunData((finishedActiveExecution.data as IRun).data);
			}
		},

		setActiveExecutions(newActiveExecutions: IExecutionsCurrentSummaryExtended[]): void {
			this.activeExecutions = newActiveExecutions;
		},

		async retryExecution(id: string, loadWorkflow?: boolean): Promise<boolean> {
			let sendData;
			if (loadWorkflow === true) {
				sendData = {
					loadWorkflow: true,
				};
			}
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'POST',
				`/executions/${id}/retry`,
				sendData,
			);
		},

		// Deletes executions
		async deleteExecutions(sendData: IExecutionDeleteFilter): Promise<void> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'POST',
				'/executions/delete',
				sendData as unknown as IDataObject,
			);
		},

		// TODO: For sure needs some kind of default filter like last day, with max 10 results, ...
		async getPastExecutions(
			filter: IDataObject,
			limit: number,
			lastId?: string,
			firstId?: string,
		): Promise<IExecutionsListResponse> {
			let sendData = {};
			if (filter) {
				sendData = {
					filter,
					firstId,
					lastId,
					limit,
				};
			}
			const rootStore = useRootStore();
			return await makeRestApiRequest(rootStore.getRestApiContext, 'GET', '/executions', sendData);
		},

		async getActiveExecutions(filter: IDataObject): Promise<IExecutionsCurrentSummaryExtended[]> {
			let sendData = {};
			if (filter) {
				sendData = {
					filter,
				};
			}
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'GET',
				'/executions/active',
				sendData,
			);
		},

		async getExecution(id: string): Promise<IExecutionResponse | undefined> {
			const rootStore = useRootStore();
			const response = await makeRestApiRequest(
				rootStore.getRestApiContext,
				'GET',
				`/executions/${id}`,
			);
			return response && unflattenExecutionData(response);
		},

		// Creates a new workflow
		async createNewWorkflow(sendData: IWorkflowDataUpdate): Promise<IWorkflowDb> {
			// make sure that the new ones are not active
			sendData.active = false;

			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'POST',
				'/workflows',
				sendData as unknown as IDataObject,
			);
		},

		// Updates an existing workflow
		async updateWorkflow(
			id: string,
			data: IWorkflowDataUpdate,
			forceSave = false,
		): Promise<IWorkflowDb> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'PATCH',
				`/workflows/${id}${forceSave ? '?forceSave=true' : ''}`,
				data as unknown as IDataObject,
			);
		},

		async runWorkflow(startRunData: IStartRunData): Promise<IExecutionPushResponse> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'POST',
				'/workflows/run',
				startRunData as unknown as IDataObject,
			);
		},

		async removeTestWebhook(workflowId: string): Promise<boolean> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'DELETE',
				`/test-webhook/${workflowId}`,
			);
		},

		async stopCurrentExecution(executionId: string): Promise<IExecutionsStopData> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'POST',
				`/executions/active/${executionId}/stop`,
			);
		},

		async loadCurrentWorkflowExecutions(
			requestFilter: ExecutionsQueryFilter,
		): Promise<IExecutionsSummary[]> {
			let activeExecutions = [];

			if (!requestFilter.workflowId) {
				return [];
			}
			try {
				const rootStore = useRootStore();
				if ((!requestFilter.status || !requestFilter.finished) && isEmpty(requestFilter.metadata)) {
					activeExecutions = await getActiveExecutions(rootStore.getRestApiContext, {
						workflowId: requestFilter.workflowId,
					});
				}
				const finishedExecutions = await getExecutions(rootStore.getRestApiContext, requestFilter);
				this.finishedExecutionsCount = finishedExecutions.count;
				return [...activeExecutions, ...(finishedExecutions.results || [])];
			} catch (error) {
				throw error;
			}
		},

		async fetchExecutionDataById(executionId: string): Promise<IExecutionResponse | null> {
			const rootStore = useRootStore();
			return await getExecutionData(rootStore.getRestApiContext, executionId);
		},

		deleteExecution(execution: IExecutionsSummary): void {
			this.currentWorkflowExecutions.splice(this.currentWorkflowExecutions.indexOf(execution), 1);
		},

		addToCurrentExecutions(executions: IExecutionsSummary[]): void {
			executions.forEach((execution) => {
				const exists = this.currentWorkflowExecutions.find((ex) => ex.id === execution.id);
				if (!exists && execution.workflowId === this.workflowId) {
					this.currentWorkflowExecutions.push(execution);
				}
			});
		},
		// Returns all the available timezones
		async getExecutionEvents(id: string): Promise<IAbstractEventMessage[]> {
			const rootStore = useRootStore();
			return await makeRestApiRequest(
				rootStore.getRestApiContext,
				'GET',
				'/eventbus/execution/' + id,
			);
		},
		// Binary data
		getBinaryUrl(
			binaryDataId: string,
			action: 'view' | 'download',
			fileName: string,
			mimeType: string,
		): string {
			const rootStore = useRootStore();
			let restUrl = rootStore.getRestUrl;
			if (restUrl.startsWith('/')) restUrl = window.location.origin + restUrl;
			const url = new URL(`${restUrl}/binary-data`);
			url.searchParams.append('id', binaryDataId);
			url.searchParams.append('action', action);
			if (fileName) url.searchParams.append('fileName', fileName);
			if (mimeType) url.searchParams.append('mimeType', mimeType);
			return url.toString();
		},

		setNodePristine(nodeName: string, isPristine: boolean): void {
			this.nodeMetadata = {
				...this.nodeMetadata,
				[nodeName]: {
					...this.nodeMetadata[nodeName],
					pristine: isPristine,
				},
			};
		},
	},
});
