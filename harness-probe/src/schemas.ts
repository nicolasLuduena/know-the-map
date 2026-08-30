import { Schema } from "effect";
import { Type } from "typebox";

export const EchoRequest = Schema.Struct({
  topic: Schema.String,
  angle: Schema.String,
  maxPoints: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type EchoRequest = Schema.Schema.Type<typeof EchoRequest>;

export const EchoResult = Schema.Struct({
  status: Schema.Literal("success"),
  echoedTopic: Schema.String,
  summary: Schema.String,
  keyPoints: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      detail: Schema.String,
    }),
  ),
});
export type EchoResult = Schema.Schema.Type<typeof EchoResult>;

export const EchoResultForRequest = (request: EchoRequest) =>
  EchoResult.check(
    Schema.makeFilter((result) => {
      const issues: Array<Schema.FilterIssue> = [];
      if (result.echoedTopic !== request.topic) {
        issues.push({
          path: ["echoedTopic"],
          issue: `must equal the request topic ${JSON.stringify(request.topic)}`,
        });
      }
      if (result.keyPoints.length > request.maxPoints) {
        issues.push({
          path: ["keyPoints"],
          issue: `must contain at most ${request.maxPoints} entries`,
        });
      }
      return issues;
    }),
  );

export const EchoResultWire = Type.Object({
  status: Type.Literal("success"),
  echoedTopic: Type.String(),
  summary: Type.String(),
  keyPoints: Type.Array(
    Type.Object({
      title: Type.String(),
      detail: Type.String(),
    }),
  ),
});

export const renderRequestPrompt = (request: EchoRequest): string =>
  `Complete the following task and submit your final answer ONLY through the
"submit_result" tool. The tool call arguments ARE your answer; do not write the
answer in chat text.

## Task

${JSON.stringify(request, null, 2)}

## Rules

- Reflect briefly on the topic from the given angle.
- Fill in every field of submit_result.
- echoedTopic must repeat the task's "topic" value verbatim.
- keyPoints must contain at most ${request.maxPoints} entries.
`;
