import { verifyBearerAuth } from "../auth.js";
import {
  invalidApiKeyError,
  methodNotAllowedError,
  modelNotFoundError,
} from "../errors.js";
import { type RequestContext, sendError, sendJson } from "../request-context.js";

export async function handleModels(
  context: RequestContext,
  modelId?: string | undefined,
): Promise<void> {
  const { req, res, requestId, config, modelCatalog } = context;
  const path = modelId ? `/v1/models/${modelId}` : "/v1/models";

  // 1. Method check: only GET is allowed
  if (req.method !== "GET") {
    sendError(
      res,
      methodNotAllowedError(req.method ?? "UNKNOWN", path, ["GET"]),
      requestId,
      { Allow: "GET" },
    );
    return;
  }

  // 2. Bearer Authentication check
  const authHeader = req.headers["authorization"];
  const isAuthorized = verifyBearerAuth(authHeader, config.apiKey);
  if (!isAuthorized) {
    sendError(res, invalidApiKeyError(), requestId);
    return;
  }

  // 3. Dispatch to list or single model
  try {
    if (modelId) {
      const model = await modelCatalog.getModel(modelId);
      if (!model) {
        sendError(res, modelNotFoundError(modelId), requestId);
        return;
      }
      sendJson(res, 200, model, requestId);
    } else {
      const list = await modelCatalog.listModels();
      sendJson(res, 200, list, requestId);
    }
  } catch (error) {
    sendError(res, error, requestId);
  }
}
