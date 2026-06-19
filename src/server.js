
import express from "express";
import { 
  fetchPatients, 
  fetchStats, 
  fetchPatientsByDay, 
  fetchPatientVisitDetails, 
  fetchDoctorStats, 
  fetchAnalytics, 
  fetchVisitTimeline, 
  fetchFilterOptions, 
  fetchOpdOutstanding, 
  fetchDeptSummary,
  fetchItemDetail,
  fetchCaseList,
} from "./controllers/patientController.js";

const app = express();

app.get("/api/patients", fetchPatients); // ✔ ใช้ได้แล้ว
app.get("/api/stats", fetchStats);       // ✔ dashboard
app.get("/api/patients/daily", fetchPatientsByDay)
app.get("/api/patients/visits", fetchPatientVisitDetails)
app.get("/api/doctor-stats", fetchDoctorStats)
app.get("/api/analytics", fetchAnalytics)
app.get("/api/visit-timeline", fetchAnalytics)
app.get("/api/filter-options", fetchFilterOptions)
app.get("/api/opd-outstanding", fetchOpdOutstanding)
app.get("/api/dept-summary", fetchDeptSummary)
app.get("/api/item-detail", fetchItemDetail)
app.get("/api/case-list", fetchCaseList)

console.log("registered: /api/doctor-stats")


app.listen(5000, () => {
  console.log("Server running on port 5000");
});