/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Urbay Inc. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { TicketChangeActorInput } from './ticketChangeLog.js';
import { ITicketRestoreResult } from './ticketRestore.js';
import { ITemplateStatusLike } from './ticketStatusPicker.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ITicketLabelDefinition } from './ticketLabels.js';
import { ITicketSubtreeSummary } from './ticketSubtreeCount.js';

export const WORKSPACES_EXPLORER_VIEWLET_ID = 'workbench.view.workspacesExplorer';
export const WORKSPACE_PANE_VIEW_ID = 'workbench.workspacesExplorer.mainPane';
export const WORKSPACES_EXPLORER_VIEW_ID = WORKSPACE_PANE_VIEW_ID;

export interface IWorkspaceItem {
	id: string;
	name: string;
	uri: URI;
	code?: string;
	isCurrent?: boolean;
	isSaved?: boolean;
	jobCount?: number;
	isMissing?: boolean;
	missingReason?: string;
	hasDamagedDescendant?: boolean;
	detectedType?: ResourceType;
}

export type ResourceType = 'workspace' | 'job' | 'project' | 'task' | 'workflow' | 'case' | 'agent' | 'issue' | 'analysis' | 'folder' | 'file' | string;

export interface IWorkspaceChildItem {
	id: string;
	name: string;
	uri: URI;
	type: ResourceType;
	code?: string;
	ticketId?: string;
	title?: string;
	status?: string;
	/** The ticket's labels (`- **Labels**:` in its ticket.md). */
	labels?: string[];
	isMissing?: boolean;
	missingReason?: string;
	hasDamagedDescendant?: boolean;
	children?: IWorkspaceChildItem[];
}

export interface ICreateResourceOptions {
	workspaceUri?: URI;
	targetParentUri?: URI;
	type: ResourceType;
	name: string;
	title?: string;
	workspaceId?: string;
	description?: string;
	code?: string;
	status?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	linkTo?: string;
	linkedBy?: string;
	attachments?: URI[];
	agentRulePrompt?: string;
	parentEntityUri?: URI;
	agentModel?: {
		providerId: string;
		modelId: string;
		modelName?: string;
		credentialId?: string;
	};
	agentAvatarIcon?: string;
	agentSystemPrompt?: string;
	agentRole?: string;
	typeDefinition?: string;
	typePrompt?: string;
	ticketPrompt?: string;
	customMetadata?: { [key: string]: string };
	customStatuses?: string[];
	statusMapping?: { [statusName: string]: CanonicalStatusCategory };
	removedStatus?: string;
	/** Workspace creation: the workspace's label definitions (`Ticket Labels`). */
	labelDefinitions?: ITicketLabelDefinition[];
	/** Ticket creation: the ticket's labels (`Labels`). */
	labels?: string[];
	gitRepoUrl?: string;
	gitBranch?: string;
	/**
	 * Set only by the manual create dialog: Freestyle tickets (type `freestyle`) may only be created there.
	 * Without it, creating a Freestyle ticket is refused.
	 */
	allowFreestyle?: boolean;
	/**
	 * Sub-Workflow tickets (type `sub_workflow`) only: the optional definition (object or JSON text with name, nodes,
	 * links, inputs, outputs). Validated; when omitted the ticket gets an empty definition (no nodes, empty contract).
	 * The ticket must be created inside a workflow folder (the parent workflow), otherwise creation fails.
	 */
	subWorkflowDefinition?: unknown;
	/**
	 * Internal (encapsulation and the one-time migration): `subWorkflowDefinition` is a complete definition whose
	 * source workflow is already known, so the parent folder is not checked for being a workflow folder.
	 */
	subWorkflowSourceKnown?: boolean;
}

export type CanonicalStatusCategory = 'Todo' | 'In Progress' | 'Done' | 'Blocked' | 'Removed';

export interface IWorkspaceStatusesInfo {
	statuses: string[];
	mapping: { [statusName: string]: CanonicalStatusCategory };
	removedStatus: string;
	initialStatus: string;
	/** The workspace's label definitions (`Ticket Labels` in the workspace ticket.md); empty when none. */
	labels?: readonly ITicketLabelDefinition[];
	getCategory(statusName?: string): CanonicalStatusCategory;
}

/** A change to a workspace's status lifecycle and / or label definitions (UI-13, UI-14). */
export interface IWorkspaceLifecycleUpdate {
	statuses?: string[];
	mapping?: { [statusName: string]: CanonicalStatusCategory };
	removedStatus?: string;
	labels?: ITicketLabelDefinition[];
	/** Ticket status changes (old -> new, case-insensitive) applied to every ticket of the workspace. */
	statusMigration?: { [oldStatus: string]: string };
	/** Label renames (old -> new, case-insensitive) applied to every ticket of the workspace. */
	labelRenames?: { [oldLabel: string]: string };
}

export interface ICreateResourceResult {
	alreadyExists?: boolean;
	uri: URI;
	folderUri?: URI;
	type?: ResourceType;
	name?: string;
	code?: string;
}

export interface ICreateWorkspaceResult {
	alreadyExists?: boolean;
	uri: URI;
	folderUri?: URI;
	name?: string;
	code?: string;
}

export interface IEntityGitSnapshot {
	remoteUrl?: string;
	branch?: string;
	lastCommitHash?: string;
	lastCommitMsg?: string;
	hasUncommittedChanges?: boolean;
	stashCount?: number;
}

export interface IEntityMetadataSnapshot {
	entityUri: string;
	entityName: string;
	entityType: ResourceType;
	ownerAccount: string;
	createdAt: string;
	title?: string;
	ticketId?: string;
	workspaceId?: string;
	description?: string;
	belongsToWorkspaceUri?: string;
	entityCode?: string;
	priority?: string;
	assignedAgentId?: string;
	assignedAgentName?: string;
	agentRulePrompt?: string;
	primaryLanguage?: string;
	lastKnownChildren?: string[];
	git?: IEntityGitSnapshot;
}

export interface IWorkspaceChildrenPage {
	items: IWorkspaceChildItem[];
	totalCount: number;
	hasMore: boolean;
}

export const IWorkspacesExplorerService = createDecorator<IWorkspacesExplorerService>('workspacesExplorerService');

export interface IWorkspacesExplorerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeWorkspaces: Event<void>;
	/** Fires with the ticket folder after a `sub_workflow` ticket (and its definition file) was created. */
	readonly onDidCreateSubWorkflowTicket: Event<URI>;

	getActiveUserEmail(): string;
	getWorkspaces(): Promise<IWorkspaceItem[]>;
	addWorkspace(uri: URI, name?: string): Promise<void>;
	removeWorkspace(uri: URI): Promise<void>;
	scanWorkspaceChildren(workspaceUri: URI, includeRemoved?: boolean): Promise<IWorkspaceChildItem[]>;
	scanWorkspaceChildrenPaginated(workspaceUri: URI, includeRemoved?: boolean, limit?: number): Promise<IWorkspaceChildrenPage>;
	detectCustomEntityTypeFromDisk(childUri: URI): Promise<ResourceType>;
	detectCustomEntityStatusFromDisk(childUri: URI): Promise<string | undefined>;
	/** Writes a ticket's status; the change is recorded in its work log as `actor` (default User, CI-50). */
	setEntityStatus(entityUri: URI, status: string, actor?: TicketChangeActorInput): Promise<void>;
	/**
	 * Restores a removed ticket (UI-19) to the status it had right before it was (last) moved to a Removed category
	 * status, read from its field change log (CI-50); falls back to the lifecycle's initial status when there is no such
	 * record, the previous status was a removed status or it is no longer in the ticket's effective lifecycle
	 * (`templateStatuses` when the ticket's template defines any, else the workspace lifecycle). The write is recorded
	 * as `actor` (default User). A ticket that is not removed is left unchanged (`changed: false`).
	 */
	restoreEntity(entityUri: URI, actor?: TicketChangeActorInput, templateStatuses?: readonly ITemplateStatusLike[]): Promise<ITicketRestoreResult>;
	/** Writes a ticket's priority (`- **Priority**:` line of its ticket.md); recorded in its work log as `actor` (default User, UI-18). */
	setEntityPriority(entityUri: URI, priority: string, actor?: TicketChangeActorInput): Promise<void>;
	/** Writes a ticket's labels (`- **Labels**:` line of its ticket.md); recorded in its work log as `actor` (default User). */
	setEntityLabels(entityUri: URI, labels: string[], actor?: TicketChangeActorInput): Promise<void>;
	/** Number of tickets (including the workspace root ticket) per status in the workspace containing `targetUri`. */
	getWorkspaceStatusUsage(targetUri: URI): Promise<{ [status: string]: number }>;
	/**
	 * Saves the lifecycle / labels in the workspace root ticket.md (Profile Data and Self Defined Data Value), applies
	 * the status migration and label renames to the workspace's tickets, and refreshes caches and views.
	 */
	updateWorkspaceLifecycle(workspaceUri: URI, update: IWorkspaceLifecycleUpdate, actor?: TicketChangeActorInput): Promise<{ migratedTickets: number }>;
	getWorkspaceStatuses(targetUri: URI): Promise<IWorkspaceStatusesInfo>;
	/**
	 * The ticket sub-tree below `folderUri` (ticket folders only, all levels, depth / size capped) with each ticket's
	 * status category, for the child-count pill (UI-17). Cached; invalidated by file changes under the folder.
	 */
	getTicketSubtreeSummary(folderUri: URI): Promise<ITicketSubtreeSummary>;
	/** The cached summary of {@link getTicketSubtreeSummary}, or undefined when it is not (or no longer) cached. */
	peekTicketSubtreeSummary(folderUri: URI): ITicketSubtreeSummary | undefined;
	createResourceUnderWorkspace(options: ICreateResourceOptions): Promise<ICreateResourceResult>;
	createWorkspace(options: ICreateResourceOptions): Promise<ICreateWorkspaceResult>;
	createWorkspaceWithNameAndPath(name: string, parentLocationUri: URI, description?: string): Promise<ICreateWorkspaceResult>;
	generateNextSequentialName(targetParentUri: URI, type: ResourceType, customCode?: string): Promise<{ name: string; code: string }>;
	resolveEntityCode(targetParentUri: URI, customCode?: string): Promise<string>;
	reorderWorkspaces(sourceId: string, targetId: string): Promise<void>;
	findWorkspaceRootUri(targetUri: URI): Promise<URI>;
	getMetadataSnapshot(uri: URI | string): IEntityMetadataSnapshot | undefined;
	saveMetadataSnapshot(snapshot: IEntityMetadataSnapshot): Promise<void>;
	removeSnapshot(uri: URI): Promise<void>;
}
