import { Router } from "express";

const router = Router();

// Public (no auth): used by monitoring.
router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "backend-horarios-merkahorro",
    version: "1.0.0",
    time: new Date().toISOString(),
  });
});

export default router;
