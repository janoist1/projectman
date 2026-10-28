import {
  ApiError,
  ChangeTaskLabelsRequest,
  CreateTaskCommentRequest,
  TaskDetail,
  UpdateTaskRequest,
  UpdateTaskResponse,
  accessOfHandle,
  canCommentOnTask,
  commentMentions,
} from '@projectman/shared';
import { http, HttpResponse } from 'msw';
import type { HttpHandler } from 'msw';
import { z } from 'zod';
import type { MockBackend } from '../../mocks/backend';
import { apiFailure, checked, recordViolation } from './contract';
import type { ApiFailure } from './contract';
import { server } from './server';

type Reply<Req, Res> = Res | ApiFailure | ((input: { taskKey: string; body: Req }) => Res | ApiFailure);
const path = '*/api/projects/:projectKey/tasks/';

function response<Res extends object>(
  schema: z.ZodType<Res>,
  value: Res | ApiFailure,
  status: number,
): Response {
  if (typeof value === 'object' && value !== null && 'status' in value && 'body' in value) {
    checked(z.number().int().min(400).max(599), value.status, 'Failure status');
    return HttpResponse.json(checked(ApiError, value.body, 'Failure response'), { status: value.status });
  }
  return HttpResponse.json(checked(schema, value, 'Task response'), { status });
}

function handler<Req, Res extends object>(
  method: 'get' | 'patch' | 'post',
  route: string,
  requestSchema: z.ZodType<Req>,
  responseSchema: z.ZodType<Res>,
  reply: Reply<Req, Res>,
  status = 200,
): HttpHandler {
  if (typeof reply !== 'function') response(responseSchema, reply, status);
  return http[method](route, async ({ request, params }) => {
    const where = `${request.method} ${new URL(request.url).pathname}`;
    let body: Req;
    try {
      body = checked(requestSchema, method === 'get' ? undefined : await request.json(), where);
    } catch (error) {
      recordViolation(`${where}: ${String(error)}`);
      return response(ApiError, apiFailure(400, 'invalid_request').body, 400);
    }
    try {
      const taskKey = String(params.taskKey ?? new URL(request.url).pathname.split('/')[5]);
      const value = typeof reply === 'function' ? reply({ taskKey, body }) : reply;
      return response(responseSchema, value, status);
    } catch (error) {
      recordViolation(`${where}: ${String(error)}`);
      return response(ApiError, apiFailure(500, 'contract_violation').body, 500);
    }
  });
}

export function onTaskDetail(taskKey: string, reply: Reply<undefined, TaskDetail>): void {
  server.use(handler('get', `${path}${taskKey}`, z.undefined(), TaskDetail, reply));
}

export function onTaskUpdate(taskKey: string, reply: Reply<UpdateTaskRequest, UpdateTaskResponse>): void {
  server.use(handler('patch', `${path}${taskKey}`, UpdateTaskRequest, UpdateTaskResponse, reply));
}

export function onTaskComment(taskKey: string, reply: Reply<CreateTaskCommentRequest, TaskDetail>): void {
  server.use(handler('post', `${path}${taskKey}/comments`, CreateTaskCommentRequest, TaskDetail, reply, 201));
}

export function onTaskLabels(taskKey: string, reply: Reply<ChangeTaskLabelsRequest, TaskDetail>): void {
  server.use(handler('post', `${path}${taskKey}/labels`, ChangeTaskLabelsRequest, TaskDetail, reply));
}

export function defaultTaskHandlers(backend: MockBackend): HttpHandler[] {
  const detail = (taskKey: string) => {
    const task = backend.findTask(taskKey);
    return task ? backend.taskDetail(task) : apiFailure(404, 'not_found');
  };
  const note = (taskKey: string, body: CreateTaskCommentRequest) => {
    const { text, ...imported } = body;
    backend.addTimeline(taskKey, backend.viewerHandle, 'task_note', {
      text,
      mentions: commentMentions(
        text,
        backend.config.team.members.map((member) => member.handle),
        backend.viewerHandle,
      ),
      ...imported,
    });
  };
  return [
    handler('get', `${path}:taskKey`, z.undefined(), TaskDetail, ({ taskKey }) => detail(taskKey)),
    handler('patch', `${path}:taskKey`, UpdateTaskRequest, UpdateTaskResponse, ({ taskKey, body }) => {
      if (!backend.findTask(taskKey)) return apiFailure(404, 'not_found');
      const { relations, despitePrerequisites, complexity, ...patch } = body;
      if (relations !== undefined || despitePrerequisites !== undefined)
        throw new Error('relations/despitePrerequisites: give the answer with onTaskUpdate');
      if (complexity !== undefined) {
        const result = backend.setTaskComplexity(taskKey, complexity);
        if (result.status !== 200) return result as ApiFailure;
      }
      return backend.updateTask(taskKey, {
        ...patch,
      })!;
    }),
    handler(
      'post',
      `${path}:taskKey/comments`,
      CreateTaskCommentRequest,
      TaskDetail,
      ({ taskKey, body }) => {
        if (!backend.findTask(taskKey)) return apiFailure(404, 'not_found');
        // The server's rules (PM-985): every member but a viewer comments, imported comments are owner-only.
        const access = accessOfHandle(backend.config, backend.viewerHandle);
        if (!canCommentOnTask(access)) return apiFailure(403, 'insufficient_access');
        if ((body.importedAuthor !== undefined || body.importedAt !== undefined) && access !== 'owner')
          return apiFailure(403, 'insufficient_access');
        note(taskKey, body);
        return detail(taskKey);
      },
      201,
    ),
    handler('post', `${path}:taskKey/labels`, ChangeTaskLabelsRequest, TaskDetail, ({ taskKey, body }) => {
      const task = backend.findTask(taskKey);
      if (!task) return apiFailure(404, 'not_found');
      backend.updateTask(taskKey, {
        labels: [
          ...new Set([...task.labels.filter((label) => !body.remove?.includes(label)), ...(body.add ?? [])]),
        ],
      });
      if (body.comment) note(taskKey, { text: body.comment });
      return detail(taskKey);
    }),
  ];
}
