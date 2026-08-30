import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  EchoRequest,
  EchoResultForRequest,
  type EchoResult,
} from "./schemas.ts";

const request = EchoRequest.make({
  topic: "structured transport",
  angle: "confirm a typed round trip",
  maxPoints: 2,
});

const result: EchoResult = {
  status: "success",
  echoedTopic: request.topic,
  summary: "The round trip completed.",
  keyPoints: [
    { title: "Request", detail: "The typed request arrived." },
    { title: "Response", detail: "The typed result returned." },
  ],
};

describe("EchoResultForRequest", () => {
  test("accepts a result that satisfies the request contract", () => {
    expect(Schema.is(EchoResultForRequest(request))(result)).toBe(true);
  });

  test("rejects a changed topic", () => {
    expect(
      Schema.is(EchoResultForRequest(request))({
        ...result,
        echoedTopic: "different topic",
      }),
    ).toBe(false);
  });

  test("rejects too many key points", () => {
    expect(
      Schema.is(EchoResultForRequest(request))({
        ...result,
        keyPoints: [
          ...result.keyPoints,
          { title: "Extra", detail: "This exceeds maxPoints." },
        ],
      }),
    ).toBe(false);
  });
});
