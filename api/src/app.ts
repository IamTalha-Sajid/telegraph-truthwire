import express from "express";
import { BitMindClient } from "./clients/bitmindClient";
import { ItsAiClient } from "./clients/itsAiClient";
import { AppConfig } from "./config";
import { VxTwitterPostProvider } from "./providers/vxTwitterPostProvider";
import { createPostDetailsRoute } from "./routes/postDetailsRoute";
import { createVerifyRoute } from "./routes/verifyRoute";
import { VerificationService } from "./services/verificationService";
import { XPostService } from "./services/xPostService";

export function createApp(config: AppConfig) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - started;
      console.log(`[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  const xProvider = new VxTwitterPostProvider({
    apiBase: config.vxApiBase
  });
  const xPostService = new XPostService(xProvider, "vx-twitter");

  const bitmind = new BitMindClient({
    baseUrl: config.telegraphBaseUrl,
    subnetPrefix: config.bitmindSubnetPrefix,
    timeoutMs: config.bitmindRequestTimeoutMs
  });

  const itsAi = new ItsAiClient({
    baseUrl: config.telegraphBaseUrl,
    subnetPrefix: config.itsAiSubnetPrefix,
    timeoutMs: config.itsAiRequestTimeoutMs
  });

  const verificationService = new VerificationService(xPostService, bitmind, itsAi);

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use("/api/x", createPostDetailsRoute(xPostService));
  app.use("/api/x", createVerifyRoute(verificationService));

  return app;
}
