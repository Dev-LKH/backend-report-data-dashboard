import express from "express";
import { fetchPatients, fetchPatientsByDay, fetchPatientVisitDetails, fetchStats, fetchDoctorStats } from "../controllers/patientController.js";

const router = express.Router();

router.get("/", fetchPatients);
router.get("/stats", fetchStats);
router.get("/by-day", fetchPatientsByDay);
router.get("visit-detail", fetchPatientVisitDetails)
router.get("/doctor-stats", fetchDoctorStats)


export default router;