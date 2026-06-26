import express from "express";
import {
  fetchPatients,
  fetchPatientsByDay,
  fetchPatientVisitDetails,
  fetchStats,
  fetchDoctorStats,
  fetchCaseList,          // เพิ่มตรงนี้
} from "../controllers/patientController.js";

const router = express.Router();

router.get("/", fetchPatients);
router.get("/stats", fetchStats);
router.get("/by-day", fetchPatientsByDay);
router.get("visit-detail", fetchPatientVisitDetails);
router.get("/doctor-stats", fetchDoctorStats);
router.get("/case-list", fetchCaseList);   // เพิ่มตรงนี้
router.get("/visit-detail", fetchPatientVisitDetails);  // ✅ เพิ่ม /


export default router;