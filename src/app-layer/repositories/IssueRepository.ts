/**
 * @deprecated Use TaskRepository instead. This file re-exports for backward compatibility.
 */
import { TaskRepository, TaskLinkRepository, TaskCommentRepository, TaskWatcherRepository } from './TaskRepository';
import type { TaskFilters } from './TaskRepository';

/** @deprecated Use TaskFilters */
export type IssueFilters = TaskFilters;
/** @deprecated Use TaskRepository */
export const IssueRepository = TaskRepository;
/** @deprecated Use TaskLinkRepository */
export const IssueLinkRepository = TaskLinkRepository;
/** @deprecated Use TaskCommentRepository */
export const IssueCommentRepository = TaskCommentRepository;
/** @deprecated Use TaskWatcherRepository */
export const IssueWatcherRepository = TaskWatcherRepository;
