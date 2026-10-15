/**
 * Server side of TypeSafe's System One wire format (`POST /v1/systemone`),
 * served by the auth-gateway so TypeSafe SDKs and omp's own `NativeJudge`
 * can point `TYPESAFE_BASE_URL` at the gateway and never hold the real key.
 *
 * Requests are validated only as far as routing needs — the `model` id, the
 * shape of the `questions` map, and optional embedded base64 images — and
 * otherwise forwarded to the selected native judgment wire. Validation
 * failures answer `422` like TypeSafe.
 */
import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import { isEmbeddedImageContent } from "../images/shared";
import type { JudgmentRequest, JudgmentResult } from "../judgment/types";
import type { ImageContent } from "../types";

/** Image shape only; the shared embedded-image guard validates data, MIME type, and detail. */
const systemOneImageSchema = type({
	type: "'image'",
	data: "string > 0",
	mimeType: "string > 0",
	"detail?": "unknown",
});

/**
 * TypeSafe accepts `instructions` and `criteria` as strings or structured
 * JSON (https://docs.typesafe.ai/api); only `type` decides how an answer is
 * read back, so that is all the gateway pins down.
 */
const systemOneRequestSchema = type({
	model: "string > 0",
	state: "string | object",
	questions: type({ "[string]": { type: "'noul' | 'choice' | 'score'", instructions: "string | object" } }),
	"images?": systemOneImageSchema.array(),
});

export interface SystemOneParsedRequest {
	modelId: string;
	request: JudgmentRequest;
}

/** `POST /v1/systemone` response body; `cost` (USD) appears only when the route billed one. */
export interface SystemOneResponseBody {
	model: string;
	answers: JudgmentResult["answers"];
	usage: { input_tokens: number; output_tokens: number; cost?: number };
}

/**
 * Validate the routing-relevant parts of a System One request body, including
 * optional embedded base64 images.
 *
 * @throws {AIError.ValidationError} when required routing fields are missing
 * or malformed, or a supplied image is malformed.
 */
export function parseRequest(body: unknown): SystemOneParsedRequest {
	const parsed = systemOneRequestSchema(body);
	if (parsed instanceof type.errors) throw new AIError.ValidationError(`systemone: ${parsed.summary}`);
	// `req.json()` output is JSON by construction, and the typed `Questions`
	// contract models string instructions only; native judgment wires transform
	// question fields as needed, while image bytes stay separate from `state`.
	const images: ImageContent[] | undefined = parsed.images?.map((image, index) => {
		if (!isEmbeddedImageContent(image)) {
			throw new AIError.ValidationError(
				`systemone: images[${index}] must contain non-empty base64 data and an image MIME type`,
			);
		}
		return image;
	});
	const request = {
		state: parsed.state,
		questions: parsed.questions,
		...(images === undefined ? {} : { images }),
	} as JudgmentRequest;
	return { modelId: parsed.model, request };
}

/** Re-encode a judgment result in TypeSafe's response shape. */
export function encodeResponse(result: JudgmentResult): SystemOneResponseBody {
	const usage: SystemOneResponseBody["usage"] = {
		input_tokens: result.usage.input,
		output_tokens: result.usage.output,
	};
	if (result.usage.cost.total > 0) usage.cost = result.usage.cost.total;
	return { model: result.model, answers: result.answers, usage };
}

/** TypeSafe answers errors with a status code and a JSON body; the envelope mirrors the other gateway routes. */
export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
