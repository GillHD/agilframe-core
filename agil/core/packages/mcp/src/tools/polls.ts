/**
 * Room polls & Q&A tools.
 *
 * Polls are created by hosts/moderators, participants vote (REST is idempotent),
 * results and status are broadcast over WS (`poll.updated`). All tools validate
 * with the shared `@agil/protocol` schemas and support `dryRun` (nothing is sent
 * to the server). Read mode exposes only `agil_list_polls`.
 */
import { z } from 'zod';
import {
  createPollSchema,
  publicPaths,
  type PollListResponse,
  type PollVoteResponse,
  type RoomPoll,
  votePollSchema,
} from '@agil/protocol';
import { ApiError } from '../http-client.js';
import { defineTool, formatZodIssues, jsonOutcome, ToolError, type AnyToolSpec, type ToolContext } from '../tool-kit.js';

const roomIdSchema = z.string().min(1).max(128).describe('Room id');
const pollIdSchema = z.string().min(1).max(128).describe('Poll id');
const optionIdSchema = z.string().min(1).max(128);

export interface PollCreateInput {
  question: string;
  options: string[];
  multiple?: boolean;
  anonymous?: boolean;
  kind?: 'poll' | 'qna';
}

/** Converts MCP-friendly string options into the protocol payload and validates it. */
export function buildCreatePollBody(args: PollCreateInput): z.output<typeof createPollSchema> {
  const options = args.options.map((text) => ({ text: text.trim() })).filter((option) => option.text.length > 0);
  if (options.length !== args.options.length) {
    throw new ToolError('Poll options must not be empty.', 'Pass 2–10 non-empty option texts: options: ["Да", "Нет"].');
  }
  const texts = options.map((option) => option.text.toLowerCase());
  if (new Set(texts).size !== texts.length) {
    throw new ToolError('Poll options must be unique.', 'Remove duplicate option texts.');
  }
  const parsed = createPollSchema.safeParse({
    question: args.question.trim(),
    options,
    ...(args.multiple !== undefined ? { multiple: args.multiple } : {}),
    ...(args.anonymous !== undefined ? { anonymous: args.anonymous } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
  });
  if (!parsed.success) {
    throw new ToolError(
      `Invalid poll payload:\n${formatZodIssues(parsed.error).join('\n')}`,
      'question: 3–500 chars; options: 2–10 unique texts (1–200 chars); kind: poll|qna.',
    );
  }
  return parsed.data;
}

export function buildVotePollBody(optionIds: string[]): z.output<typeof votePollSchema> {
  const unique = [...new Set(optionIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (unique.length !== optionIds.length) {
    throw new ToolError('optionIds must not contain empty or duplicate ids.', 'Pass 1–10 distinct option ids from agil_list_polls.');
  }
  const parsed = votePollSchema.safeParse({ optionIds: unique });
  if (!parsed.success) {
    throw new ToolError(`Invalid vote payload:\n${formatZodIssues(parsed.error).join('\n')}`, 'optionIds: 1–10 ids.');
  }
  return parsed.data;
}

/** Maps HTTP failures to actionable tool errors (polls may require a newer server). */
export function pollHttpError(error: unknown, action: string): never {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      throw new ToolError(
        `${action}: room or poll not found (404).`,
        'Check roomId/pollId with agil_list_rooms / agil_list_polls. Polls endpoints require a server with Wave 1 polls support.',
      );
    }
    if (error.status === 403) {
      throw new ToolError(
        `${action}: forbidden (403).`,
        'Creating/closing polls requires host or moderator permissions; voting requires a join token with the poll permission.',
      );
    }
    if (error.status === 409) {
      throw new ToolError(`${action}: conflict (409).`, 'The poll is already closed or the vote conflicts with a previous one.');
    }
    throw new ToolError(`${action}: HTTP ${error.status} — ${error.message}`);
  }
  throw error;
}

function pollSummary(poll: RoomPoll): Record<string, unknown> {
  return {
    id: poll.id,
    question: poll.question,
    kind: poll.kind,
    status: poll.status,
    multiple: poll.multiple,
    anonymous: poll.anonymous,
    totalVotes: poll.totalVotes,
    voted: poll.voted ?? false,
    createdBy: poll.createdBy,
    options: poll.options.map((option) => ({ id: option.id, text: option.text, votes: option.votes, share: option.share, selected: option.selected ?? false })),
    ...(poll.closedAt ? { closedAt: poll.closedAt } : {}),
  };
}

export function pollToolSpecs(): AnyToolSpec[] {
  return [
    defineTool({
      name: 'agil_list_polls',
      title: 'List room polls with results',
      description:
        'List polls and Q&A for a room with live results (votes, shares, whether the current participant voted). ' +
        'GET /v1/rooms/:roomId/polls. Available in read-only MCP mode. Use it before voting/closing to get pollId and option ids.',
      online: true,
      inputSchema: z.object({ roomId: roomIdSchema }),
      handler: async (args, ctx) => {
        let payload: PollListResponse;
        try {
          payload = await ctx.client.get<PollListResponse>(publicPaths.roomPolls(encodeURIComponent(args.roomId)));
        } catch (error) {
          pollHttpError(error, 'List polls');
        }
        const polls = Array.isArray(payload?.polls) ? payload.polls : [];
        return jsonOutcome({
          roomId: payload?.roomId ?? args.roomId,
          count: polls.length,
          polls: polls.map(pollSummary),
          ...(polls.length === 0 ? { note: 'No polls in this room yet.' } : {}),
        });
      },
    }),

    defineTool({
      name: 'agil_create_poll',
      title: 'Create a room poll (host/moderator)',
      description:
        'Create a poll or Q&A in a room (host/moderator). Validates the shared createPollSchema: question 3–500 chars, ' +
        '2–10 unique non-empty options, multiple, anonymous, kind= poll|qna. POST /v1/rooms/:roomId/polls. ' +
        'dryRun=true validates locally and returns the exact payload without creating anything. ' +
        'Results/status are broadcast to the dashboard/widget via WS poll.updated.',
      online: true,
      inputSchema: z.object({
        roomId: roomIdSchema,
        question: z.string().min(3).max(500).describe('Poll question (3–500 chars)'),
        options: z.array(z.string()).min(2).max(10).describe('2–10 answer options (unique, non-empty, ≤200 chars each)'),
        multiple: z.boolean().optional().describe('Allow selecting several options'),
        anonymous: z.boolean().optional().describe('Legacy field. Results are aggregated for either value.'),
        kind: z.enum(['poll', 'qna']).optional().describe('poll (default) or qna'),
        dryRun: z.boolean().default(false).describe('Validate locally without creating the poll'),
      }),
      write: true,
      handler: async (args, ctx) => {
        const body = buildCreatePollBody(args);
        if (args.dryRun) {
          return jsonOutcome({
            dryRun: true,
            created: false,
            roomId: args.roomId,
            payload: body,
            note: 'Nothing was sent. Remove dryRun to create the poll (host/moderator required).',
          });
        }
        let poll: RoomPoll;
        try {
          const response = await ctx.client.post<{ poll: RoomPoll }>(publicPaths.roomPolls(encodeURIComponent(args.roomId)), body);
          poll = response.poll;
        } catch (error) {
          pollHttpError(error, 'Create poll');
        }
        return jsonOutcome({ dryRun: false, created: true, updated: true, poll: pollSummary(poll) });
      },
    }),

    defineTool({
      name: 'agil_vote_poll',
      title: 'Vote in a room poll',
      description:
        'Vote in an open poll with option ids from agil_list_polls. POST /v1/rooms/:roomId/polls/:pollId/vote. ' +
        'Voting is idempotent for single-choice polls (repeat votes return accepted=false + reason). ' +
        'dryRun=true validates option ids locally without voting. Requires a participant/join token with poll access.',
      online: true,
      inputSchema: z.object({
        roomId: roomIdSchema,
        pollId: pollIdSchema,
        optionIds: z.array(optionIdSchema).min(1).max(10).describe('1–10 option ids from agil_list_polls'),
        dryRun: z.boolean().default(false).describe('Validate locally without voting'),
      }),
      write: true,
      handler: async (args, ctx) => {
        const body = buildVotePollBody(args.optionIds);
        if (args.dryRun) {
          return jsonOutcome({
            dryRun: true,
            accepted: false,
            roomId: args.roomId,
            pollId: args.pollId,
            payload: body,
            note: 'Nothing was sent. Remove dryRun to vote.',
          });
        }
        let response: PollVoteResponse;
        try {
          response = await ctx.client.post<PollVoteResponse>(
            publicPaths.roomPollVote(encodeURIComponent(args.roomId), encodeURIComponent(args.pollId)),
            body,
          );
        } catch (error) {
          pollHttpError(error, 'Vote');
        }
        const accepted = response?.accepted !== false;
        return jsonOutcome({
          dryRun: false,
          accepted,
          ...(accepted ? {} : { reason: response?.reason ?? 'vote-not-accepted' }),
          poll: response?.poll ? pollSummary(response.poll) : null,
          ...(accepted ? {} : { note: 'The vote was not counted (e.g. already voted in a single-choice poll or the poll is closed).' }),
        });
      },
    }),

    defineTool({
      name: 'agil_close_poll',
      title: 'Close a room poll (host)',
      description:
        'Close an open poll so no more votes are accepted (host/moderator). POST /v1/rooms/:roomId/polls/:pollId/close. ' +
        'Use dryRun=true to check the request without closing. Results stay available via agil_list_polls.',
      online: true,
      inputSchema: z.object({
        roomId: roomIdSchema,
        pollId: pollIdSchema,
        dryRun: z.boolean().default(false).describe('Validate locally without closing the poll'),
      }),
      write: true,
      handler: async (args, ctx) => {
        if (args.dryRun) {
          return jsonOutcome({
            dryRun: true,
            closed: false,
            roomId: args.roomId,
            pollId: args.pollId,
            note: 'Nothing was sent. Remove dryRun to close the poll (host/moderator required).',
          });
        }
        let poll: RoomPoll;
        try {
          const response = await ctx.client.post<{ poll: RoomPoll }>(
            publicPaths.roomPollClose(encodeURIComponent(args.roomId), encodeURIComponent(args.pollId)),
            {},
          );
          poll = response.poll;
        } catch (error) {
          pollHttpError(error, 'Close poll');
        }
        return jsonOutcome({ dryRun: false, closed: poll.status === 'closed', poll: pollSummary(poll) });
      },
    }),
  ];
}

/** Re-export for docs/tests: the poll permissions hint used in instructions. */
export const POLL_PERMISSION_NOTE =
  'Polls: hosts/moderators create and close polls (agil_create_poll, agil_close_poll); participants vote (agil_vote_poll); everyone with room access can read results (agil_list_polls). Use dryRun to preview payloads; polls are ephemeral and do not change TenantConfig.';
