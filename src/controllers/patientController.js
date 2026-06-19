import e from "express";
import { getPatients, getStats, getPatientsByDay, getPatientVisitDetails, getDoctorStats, getAnalytics, getVisitTimeline, getFilterOptions, getOpdOutstanding, getDeptSummary, getItemDetail } from "../services/patientService.js";
import { getCaseList } from "../services/patientService.js";

export const fetchPatients = async (req, res) => {
  const data = await getPatients();
  res.json(data);
};

export const fetchFilterOptions = async (req, res) => {
  try {
    const data = await getFilterOptions();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const fetchStats = async (req, res) => {
  try {
    const {range, start, end, patientType} = req.query

    let startDate, endDate
    endDate = new Date().toISOString().slice(0, 10)

    if (start && end) {
  startDate = start
  endDate = end
} else if (range === "30d") {
  const d = new Date(); d.setDate(d.getDate() - 30)
  startDate = d.toISOString().slice(0, 10)  // ✅ เพิ่ม space
} else if (range === "1y") {
  const d = new Date(); d.setFullYear(d.getFullYear() - 1)
  startDate = d.toISOString().slice(0, 10)
} else if (range === "all") {
  startDate = "2025-01-01"  // ✅ เริ่มจากปีเก่าพอ
  endDate = new Date().toISOString().slice(0, 10)
} else {
  // default = 7d
  const d = new Date(); d.setDate(d.getDate() - 6)  // ✅ แก้ -1 → -6
  startDate = d.toISOString().slice(0, 10)
}

    const data =await getStats(startDate, endDate, patientType ?? null)
    res.json(data)
  } catch(err) {
    console.error(err)
    res.status(500).json({error: err.message})
  }
};

export const fetchPatientsByDay = async (req, res) => {
  try {
    const { date } = req.query;
    const result = await getPatientsByDay(date);
    res.json(result); // ✅ แก้ data → result
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const fetchPatientVisitDetails = async (req, res) => {
  try {
    const { date } = req.query;
    const result = await getPatientVisitDetails(date); // ✅ แก้ result → date
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const fetchDoctorStats = async (req, res) => {
  try{
    const {start, end, range} = req.query

    let startDate, endDate
    endDate = new Date().toISOString().slice(0, 10)

    if(start && end) {
      startDate = start
      endDate = end
    } else if (range === "30d") {
      const d = new Date(); d.setDate(d.getDate() - 30)
      startDate = d.toISOString().slice(0, 10)
    } else if (range === "1y") {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1)
      startDate = d.toISOString().slice(0, 10)
    } else {
      const d = new Date(); d.setDate(d.getDate() - 7)
      startDate = d.toISOString().slice(0, 10)
    }

    const data = await getDoctorStats(startDate, endDate)
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(5000).json({error: err.message})
  }
}

export const fetchAnalytics = async (req, res) => {
  try {
    const {start, end, range, groupBy, patientType} = req.query

    let startDate, endDate
    endDate = new Date().toISOString().slice(0, 10)
    if (start && end) {
      startDate = start
      endDate = end
    } else if (range === "week") {
      const d = new Date(); d.setDate(d.getDate() - 6)
      startDate = d.toISOString().slice(0, 10) // ✅
    } else if (range === "month") {
      const d = new Date(); d.setMonth(d.getMonth() - 1)
      startDate = d.toISOString().slice(0, 10) // ✅
    } else if (range === "quarter") {
      const d = new Date(); d.setMonth(d.getMonth() - 3)
      startDate = d.toISOString().slice(0, 10) // ✅
    } else if (range === "year") {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1)
      startDate = d.toISOString().slice(0, 10) // ✅
    } else if (range === "all") {
      startDate = "2025-01-01"
    } else {
      const d = new Date(); d.setDate(d.getDate() - 6)
      startDate = d.toISOString().slice(0, 10)
    }

    const data = await getAnalytics(startDate, endDate, groupBy ?? "day", patientType ?? null)
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({error: err.message})
  }
}

export const fetchVisitTimeline = async (req, res) => {
  try{
    const { start, end, range} = req.query
    let startDate, endDate
    endDate = new Date().toDateString().slice(0, 10)

    if (start && end) {
      startDate = start
      endDate = end
    } else if (range === "30d") {
      const d = new Date(); d.setDate(d.getDate() - 30)
      startDate = d.toISOString().slice(0, 10)
    } else {
      startDate = endDate
    }

    const data = await getVisitTimeline(startDate, endDate)
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({error: err.message})
  }
}
export const fetchOpdOutstanding = async (req, res) => {
  try {
    const data = await getOpdOutstanding()
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: "failed" })
  }
}

export const fetchDeptSummary = async (req, res) => {
  try {
    const { start, end, range, patientType } = req.query
    let startDate, endDate
    endDate = new Date().toISOString().slice(0, 10)
    if (start && end) {
      startDate = start
      endDate = end
    } else if (range === "month") {
      const d = new Date(); d.setMonth(d.getMonth() - 1)
      startDate = d.toISOString().slice(0, 10)
    } else if (range === "year") {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1)
      startDate = d.toISOString().slice(0, 10)
    } else if (range === "all") {
      startDate = "2025-01-01"
    } else {
      const d = new Date(); d.setDate(d.getDate() - 6)
      startDate = d.toISOString().slice(0, 10)
    }
    const data = await getDeptSummary(startDate, endDate, patientType ?? null)
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({error: err.message})
  }

}

export const fetchItemDetail = async (req, res) => {
  try {
    const {start, end, range, patientType} = req.query
    let startDate, endDate
    endDate = new Date().toISOString().slice(0, 10)
    if (start && end) {
      startDate = start; 
      endDate = end
    } else if (range === "month") {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      startDate = d.toISOString().slice(0, 10)
    } else if (range === "year") {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1);
      startDate = d.toISOString().slice(0, 10) 
    } else if (range === "all") {
      startDate = '2025-08-01'
    }
    const data = await getItemDetail(startDate, endDate, patientType ?? null)
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message})
  }
}

export const fetchCaseList = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      patientType = null,
      department  = null,
      doctor      = null,
      billStatus  = null,
    } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }

    const data = await getCaseList({
      startDate,
      endDate,
      patientType: patientType || null,
      department:  department  || null,
      doctor:      doctor      || null,
      billStatus:  billStatus  || null,
    });

    res.json(data);
  } catch (err) {
    console.error("fetchCaseList error:", err);
    res.status(500).json({ error: err.message });
  }
};
