import pool from "../db.js";

export const getPatients = async () => {
  const result = await pool.query(`
    SELECT id, "HN", firstname, surname, "createdAt"
    FROM patient_patient
    ORDER BY id DESC
    LIMIT 20
  `);
  return result.rows.map(p => ({
    id: p.id,
    hn: p.HN,
    name: `${p.firstname} ${p.surname}`,
    createdAt: p.createdAt
  }));
};

export const getStats = async (startDate, endDate, patientType = null) => {
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : ""

  const visitsResult = await pool.query(`
    SELECT
      DATE(vp."createdAt") AS day,
      COUNT(DISTINCT vp.id) AS "totalVisitors",
      COUNT(DISTINCT vp.id) FILTER (
        WHERE mr."patientType" = 'OPD'
      ) AS opd,
      COUNT(DISTINCT vp.id) FILTER (
        WHERE mr."patientType" = 'IPD'
      ) AS ipd
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
    WHERE DATE(vp."createdAt") BETWEEN $1 AND $2
    ${ptFilter}
    GROUP BY DATE(vp."createdAt")
    ORDER BY day DESC
  `, [startDate, endDate])

  const deptResult = await pool.query(`
  SELECT
    DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS day,
    d.name AS department,
    COUNT(DISTINCT vp.id) AS visitors,
    COALESCE(SUM(mrn_rev.revenue), 0) AS revenue
  FROM medrec_visitingpatient vp
  JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
  LEFT JOIN (
    SELECT
      c."MRN_id",
      c.department_id,
      COALESCE(SUM(li.line_total), 0) AS revenue
    FROM medrec_case c
    LEFT JOIN (
      SELECT DISTINCT ON (case_id)
        case_id, department_id
      FROM medrec_treatment
      ORDER BY case_id, id
    ) t2 ON t2.case_id = c.id
    LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    GROUP BY c."MRN_id", t2.department_id
  ) mrn_rev ON mrn_rev."MRN_id"::text = vp."MRN_id"::text
  JOIN hospital_department d ON d.id = mrn_rev.department_id
  WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
  ${ptFilter}
  GROUP BY DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok'), d.name
  ORDER BY day DESC
`, [startDate, endDate])

  const paymentResult = await pool.query(`
    SELECT
      DATE(vp."createdAt") AS day,
      COALESCE(SUM(li.subtotal), 0)          AS gross_amount,
      COALESCE(SUM(li.discount_amount), 0)   AS total_discount,
      COALESCE(SUM(li.line_total), 0)        AS net_amount,
      COALESCE(SUM(li.patient_responsibility_amount), 0) AS self,
      COALESCE(SUM(li.insurance_covered_amount), 0)      AS insurance,
      COALESCE(SUM(li.copayment_amount), 0)              AS copayment
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN finance_medbill mb ON mb.case_id_id = c.id
    JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE DATE(vp."createdAt") BETWEEN $1 AND $2
    ${ptFilter}
    GROUP BY DATE(vp."createdAt")
    ORDER BY day DESC
  `, [startDate, endDate])

  const billBreakdownResult = await pool.query(`
  SELECT
    bill_status,
    CASE WHEN ins_total > 0 THEN 'มีประกัน' ELSE 'ไม่มีประกัน' END AS insurance_flag,
    COUNT(*) AS bill_count,
    SUM(line_total) AS total_revenue
  FROM (
    SELECT
      mb.id,
      mb.bill_status,
      COALESCE(SUM(li.insurance_covered_amount), 0) AS ins_total,
      COALESCE(SUM(li.line_total), 0) AS line_total
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE DATE(vp."createdAt") BETWEEN $1 AND $2
    ${ptFilter}
    GROUP BY mb.id, mb.bill_status
  ) sub
  GROUP BY bill_status, insurance_flag
  ORDER BY bill_status, insurance_flag
`, [startDate, endDate])

  const days = visitsResult.rows.map(v => {
    const day = v.day.toISOString().slice(0, 10)
    const departments = deptResult.rows
      .filter(d => d.day.toISOString().slice(0, 10) === day)
      .map(d => ({
        name: d.department,
        visitors: Number(d.visitors),
        revenue: Number(d.revenue),
      }))
    const payment = paymentResult.rows.find(
      p => p.day.toISOString().slice(0, 10) === day
    )
    const paymentBreakdown = {
      self: Number(payment?.self ?? 0),
      insurance: Number(payment?.insurance ?? 0),
      copayment: Number(payment?.copayment ?? 0),
      grossAmount: Number(payment?.gross_amount ?? 0),
      discount: Number(payment?.total_discount ?? 0),
      netAmount: Number(payment?.net_amount ?? 0),
      พรบ: 0,
    }
    return {
      day,
      label: new Date(day).toLocaleDateString("th-TH", {
        day: "numeric", month: "short", year: "numeric"
      }),
      totalVisitors: Number(v.totalVisitors),
      opd: Number(v.opd),
      ipd: Number(v.ipd),
      totalRevenue: departments.reduce((s, d) => s + d.revenue, 0),
      paymentBreakdown,
      departments,
    }
  })

  const billBreakdown = {
  finalizedInsurance: 0,
  finalizedSelf: 0,
  draftInsurance: 0,
  draftSelf: 0,
}
billBreakdownResult.rows.forEach(r => {
  const v = Number(r.total_revenue)
  if (r.bill_status === 'FINALIZED' && r.insurance_flag === 'มีประกัน') billBreakdown.finalizedInsurance = v
  if (r.bill_status === 'FINALIZED' && r.insurance_flag === 'ไม่มีประกัน') billBreakdown.finalizedSelf = v
  if (r.bill_status === 'DRAFT' && r.insurance_flag === 'มีประกัน') billBreakdown.draftInsurance = v
  if (r.bill_status === 'DRAFT' && r.insurance_flag === 'ไม่มีประกัน') billBreakdown.draftSelf = v
})

const totalBill = Object.values(billBreakdown).reduce((s, v) => s + v, 0)
const finalizedTotal = billBreakdown.finalizedInsurance + billBreakdown.finalizedSelf
const draftTotal = billBreakdown.draftInsurance + billBreakdown.draftSelf

return {
  days,
  billBreakdown,
  billSummary: {
    finalizedTotal,
    draftTotal,
    totalBill,
    finalizedPct: totalBill > 0 ? Math.round(finalizedTotal / totalBill * 100) : 0,
    draftPct: totalBill > 0 ? Math.round(draftTotal / totalBill * 100) : 0,
  }
}
  
}

export const getPatientsByDay = async (date) => {
  const result = await pool.query(`
    SELECT
      DATE(vp."createdAt") AS day,
      vp.id AS visit_id,
      c."visitType",
      pp.firstname || ' ' || pp.surname AS name,
      pp."HN"
    FROM medrec_visitingpatient vp
    JOIN medrec_case c ON c.id = vp."case_id"
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN patient_patient pp ON pp.id = mr."HN_id"
    WHERE DATE(vp."createdAt") = $1
    ORDER BY vp.id DESC
  `, [date]);

  return result.rows.map(r => ({
    visitId: r.visit_id,
    hn: r.HN,
    name: r.name,
    visitType: r.visitType,
    day: r.day,
  }));
};

export const getPatientVisitDetails = async (date) => {
  const result = await pool.query(`
    SELECT
      pp."HN",
      pp.firstname || ' ' || pp.surname AS name,  -- ✅ เพิ่มช่องว่าง
      c."visitType",
      DATE(vp."createdAt") AS visit_date,
      vp.id AS visit_id,
      li.service_description,                      -- ✅ แก้ discription
      li.service_location,
      li.quantity,
      li.unit_price,
      li.line_total
    FROM medrec_visitingpatient vp
    JOIN medrec_case c ON c.id = vp."case_id"
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN patient_patient pp ON pp.id = mr."HN_id"
    LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id        -- ✅ แก้ financce
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE DATE(vp."createdAt") = $1                             -- ✅ แก้ WHRER และ createAt
    ORDER BY pp."HN", li.line_total DESC
  `, [date]);

  const map = new Map();
  for (const row of result.rows) {
    const key = `${row.HN}-${row.visit_id}`;
    if (!map.has(key)) {
      map.set(key, {
        hn: row.HN,
        name: row.name,
        visitType: row.visitType,
        items: [],
        totalAmount: 0,  // ✅ แก้ totaAmount
      });
    }
    if (row.service_description) {
      map.get(key).items.push({
        description: row.service_description,
        location: row.service_location,
        quantity: Number(row.quantity ?? 1),
        unitPrice: Number(row.unit_price ?? 0),
        lineTotal: Number(row.line_total ?? 0),
      });
      map.get(key).totalAmount += Number(row.line_total ?? 0);
    }
  }
  return Array.from(map.values());
};

export const getDoctorStats = async (startDate, endDate) => {
  const result = await pool.query(`
    SELECT 
      u.id AS doctor_id,
      COALESCE(
        NULLIF(TRIM(COALESCE(u.title,'') || ' ' || COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
        'ไม่ระบุชื่อ'
      ) AS doctor_name,
      d.name AS department,
      COUNT(DISTINCT c.id) AS total_patients,
      COALESCE(SUM(li.line_total), 0) AS total_revenue
    FROM mfauth_customuser u
    JOIN medrec_case c ON c."doctor_id" = u.id
    LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li 
      ON li.med_bill_id = mb.id 
      AND li.provider_id_id = u.id  -- ✅ เพิ่ม condition นี้
    LEFT JOIN hospital_department d ON d.id = u.department_id
    WHERE DATE(c."createdAt") BETWEEN $1 AND $2
      AND c."doctor_id" IS NOT NULL
    GROUP BY u.id, u.title, u.first_name, u.last_name, d.name
    ORDER BY total_revenue DESC
  `, [startDate, endDate])

  return result.rows.map(r => ({
    id: Number(r.doctor_id),
    doctor_name: r.doctor_name,
    department: r.department ?? "ไม่ระบุแผนก",
    total_patients: Number(r.total_patients),
    total_revenue: Number(r.total_revenue),
  }))
};

export const getAnalytics = async (startDate, endDate, groupBy = "day", patientType = null) => {
  let dateTrunc
  if (groupBy === "week") dateTrunc = `DATE_TRUNC('week', vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`
  else if (groupBy === "month") dateTrunc = `DATE_TRUNC('month', vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`
  else if (groupBy === "quarter") dateTrunc = `DATE_TRUNC('quarter', vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`
  else if (groupBy === "year") dateTrunc = `DATE_TRUNC('year', vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`
  else dateTrunc = `DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`

  const ptJoin = patientType
    ? `JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text`
    : ""
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : ""

  const revenueResult = await pool.query(`
  SELECT
    ${dateTrunc} AS period,
    COUNT(DISTINCT vp.id) AS total_patients,
    COALESCE(SUM(bill_rev.revenue), 0) AS total_revenue,
    COALESCE(SUM(bill_rev.gross_amount), 0) AS gross_amount,
    COALESCE(SUM(bill_rev.total_discount), 0) AS total_discount
  FROM medrec_visitingpatient vp
  ${ptJoin}
  LEFT JOIN (
    SELECT
      c."MRN_id",
      COALESCE(SUM(li.line_total), 0) AS revenue,
      COALESCE(SUM(li.subtotal), 0) AS gross_amount,
      COALESCE(SUM(li.discount_amount), 0) AS total_discount
    FROM medrec_case c
    JOIN finance_medbill mb ON mb.case_id_id = c.id
    JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    GROUP BY c."MRN_id"
  ) bill_rev ON bill_rev."MRN_id"::text = vp."MRN_id"::text
  WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
  ${ptFilter}
  GROUP BY ${dateTrunc}
  ORDER BY period ASC
`, [startDate, endDate])

  const deptTypeResult = await pool.query(`
  SELECT
    d.type,
    COUNT(DISTINCT vp.id) AS patient_count,
    COALESCE(SUM(li.line_total), 0) AS total_revenue
  FROM medrec_visitingpatient vp
  ${ptJoin}
  JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
  LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id
  LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
  LEFT JOIN (
    SELECT DISTINCT ON (case_id)
      case_id,
      department_id
    FROM medrec_treatment
    ORDER BY case_id, id
  ) t ON t.case_id = c.id
  JOIN hospital_department d ON d.id = t.department_id
  WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
  ${ptFilter}
  GROUP BY d.type
  ORDER BY total_revenue DESC
`, [startDate, endDate])

  const deptNameResult = await pool.query(`
  SELECT
    d.name,
    d.type,
    COUNT(DISTINCT vp.id) AS patient_count,
    COALESCE(SUM(li.line_total), 0) AS revenue
  FROM medrec_visitingpatient vp
  ${ptJoin}
  JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
  LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id
  LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
  LEFT JOIN (
    SELECT DISTINCT ON (case_id)
      case_id,
      department_id
    FROM medrec_treatment
    ORDER BY case_id, id
  ) t ON t.case_id = c.id
  JOIN hospital_department d ON d.id = t.department_id
  WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
  ${ptFilter}
  GROUP BY d.name, d.type
  ORDER BY revenue DESC
`, [startDate, endDate])

  const paymentResult = await pool.query(`
    SELECT
      COALESCE(SUM(li.patient_responsibility_amount), 0) AS self,
      COALESCE(SUM(li.insurance_covered_amount), 0) AS insurance,
      COALESCE(SUM(li.copayment_amount), 0) AS copayment
    FROM medrec_visitingpatient vp
    JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
    ${ptJoin}
    LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE DATE(vp."createdAt") BETWEEN $1 AND $2
    ${ptFilter}
  `, [startDate, endDate])

  const doctorResult = await pool.query(`
    SELECT
      u.id,
      COALESCE(
        NULLIF(TRIM(COALESCE(u.title,'') || ' ' || COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
        'ไม่ระบุชื่อ'
      ) AS doctor_name,
      d.name AS department,
      COUNT(DISTINCT c.id) AS total_patients,
      COALESCE(SUM(li.line_total), 0) AS total_revenue
    FROM mfauth_customuser u
    JOIN medrec_case c ON c."doctor_id" = u.id
    LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li
      ON li.med_bill_id = mb.id
      AND li.provider_id_id = u.id
    LEFT JOIN hospital_department d ON d.id = u.department_id
    WHERE DATE(c."createdAt") BETWEEN $1 AND $2
      AND c."doctor_id" IS NOT NULL
    GROUP BY u.id, u.title, u.first_name, u.last_name, d.name
    ORDER BY total_revenue DESC
  `, [startDate, endDate])

  const billBreakdownResult = await pool.query(`
  SELECT
    bill_status,
    CASE WHEN ins_total > 0 THEN 'มีประกัน' ELSE 'ไม่มีประกัน' END AS insurance_flag,
    COUNT(*) AS bill_count,
    SUM(line_total) AS total_revenue
  FROM (
    SELECT
      mb.id,
      mb.bill_status,
      COALESCE(SUM(li.insurance_covered_amount), 0) AS ins_total,
      COALESCE(SUM(li.line_total), 0) AS line_total
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE DATE(vp."createdAt") BETWEEN $1 AND $2
    ${ptFilter}
    GROUP BY mb.id, mb.bill_status
  ) sub
  GROUP BY bill_status, insurance_flag
  ORDER BY bill_status, insurance_flag
`, [startDate, endDate])

  const todayResult = await pool.query(`
    SELECT COUNT(DISTINCT vp.id) AS total_patients
    FROM medrec_visitingpatient vp
    WHERE DATE(vp."createdAt") = CURRENT_DATE
  `)

  const totalResult = await pool.query(`
    SELECT COUNT(DISTINCT vp.id) AS total_patients
    FROM medrec_visitingpatient vp
  `)

  return {
    revenue: revenueResult.rows.map(r => ({
      period: r.period,
      label: new Date(r.period).toLocaleDateString("th-TH", {
        day: "numeric", month: "short", year: "numeric"
      }),
      total_patients: Number(r.total_patients ?? 0),
      total_revenue: Number(r.total_revenue),
      gross_amount: Number(r.gross_amount),
      total_discount: Number(r.total_discount),
    })),
    deptType: deptTypeResult.rows.map(r => ({
      type: r.type,
      visitors: Number(r.patient_count),
      revenue: Number(r.total_revenue),
    })),
    deptName: deptNameResult.rows.map(r => ({
      name: r.name,
      type: r.type,
      visitors: Number(r.patient_count),
      revenue: Number(r.revenue),
    })),
    payment: {
      self: Number(paymentResult.rows[0]?.self ?? 0),
      insurance: Number(paymentResult.rows[0]?.insurance ?? 0),
      copayment: Number(paymentResult.rows[0]?.copayment ?? 0),
      todayPatients: Number(todayResult.rows[0]?.total_patients ?? 0),
      totalPatients: Number(totalResult.rows[0]?.total_patients ?? 0),
    },
    doctors: doctorResult.rows.map(r => ({
      id: Number(r.id),
      doctor_name: r.doctor_name,
      department: r.department ?? "ไม่ระบุแผนก",
      total_patients: Number(r.total_patients),
      total_revenue: Number(r.total_revenue),
    })),
  }
}; 

export const getVisitTimeline = async (startDate, endDate) => {
  const results = await pool.query(`
    SELECT
      vp.id AS visit_id,
      pp."HN",
      pp.firstname || ' ' || pp.surname AS name,
      vp."createdAt" AS visit_datetime,
      c."visitType",
      COALESCE(
        NULLIF(TRIM(COALESCE(u.title,'') || ' ' || COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
        'ไม่ระบุชื่อ'
      ) AS doctor_name,
      d.name AS department,
      COALESCE(SUM(li.line_total), 0) AS revenue
    FROM medrec_visitingpatient vp
    JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN patient_patient pp ON pp.id = mr."HN_id"
    LEFT JOIN mfauth_customuser u ON u.id = c."doctor_id"
    LEFT JOIN medrec_treatment t ON t.case_id = c.id
    LEFT JOIN hospital_department d ON d.id = t.department_id
    LEFT JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE DATE(vp."createdAt") BETWEEN $1 AND $2
    GROUP BY vp.id, pp."HN", pp.firstname, pp.surname,
             vp."createdAt", c."visitType",
             u.title, u.first_name, u.last_name, d.name
    ORDER BY vp."createdAt" DESC
  `, [startDate, endDate])

  return results.rows.map(r => ({
    visitId: Number(r.visit_id),
    hn: r.HN,
    name: r.name,
    visit_datetime: r.visit_datetime,
    visit_date: new Date(r.visit_datetime).toLocaleDateString("th-TH", {
      day: "numeric", month: "short", year: "numeric",
    }),
    visit_time: new Date(r.visit_datetime).toLocaleTimeString("th-TH", {
      hour: "2-digit", minute: "2-digit",
      timeZone: "Asia/Bangkok",
    }),
    visitType: r.visitType,
    doctor_name: r.doctor_name,
    department: r.department ?? "ไม่ระบุ",
    revenue: Number(r.revenue),
  }))
}

export const getFilterOptions = async () => {
  const deptResult = await pool.query(`
    SELECT
      DISTINCT d.name AS department
      FROM hospital_department d
      WHERE name IS NOT NULL
      ORDER BY name 
    `)

  const doctorResult = await pool.query(`
    SELECT DISTINCT
      u.id,
      COALESCE(
        NULLIF(TRIM(COALESCE(u.title, '') || ' ' || COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
        'ไม่ระบุชื่อ'
      ) AS doctor_name
      FROM mfauth_customuser u
      ORDER BY doctor_name
    `)

  return {
    departments: deptResult.rows.map(r => r.name),
    doctors: doctorResult.rows.map(r => ({
      id: Number(r.id),
      name: r.doctor_name,
    }))
  }
} 

export const getOpdOutstanding = async () => {
  const result = await pool.query(`
    SELECT
      pp."HN",
      pp.firstname || ' ' || pp.surname AS name,
      mr."MRN",
      mb.bill_status,
      mb.total_amount,
      COALESCE(SUM(li.patient_responsibility_amount), 0) AS self_pay,
      COALESCE(SUM(li.insurance_covered_amount), 0)      AS insurance_covered,
      COALESCE(SUM(li.copayment_amount), 0)              AS copayment,
      CASE WHEN SUM(li.insurance_covered_amount) > 0
        THEN 'ใช้เครดิต'
        ELSE '-'
      END AS credit_flag
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
    JOIN patient_patient pp ON pp.id = mr."HN_id"
    JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN finance_medbill mb ON mb.case_id_id = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE mr."patientType" = 'OPD'
      AND mb.bill_status = 'DRAFT'
    GROUP BY pp."HN", pp.firstname, pp.surname, mr."MRN", mb.bill_status, mb.total_amount
    ORDER BY mb.total_amount DESC
  `)

  return result.rows.map(r => ({
    hn: r.HN,
    name: r.name,
    mrn: r.MRN,
    billStatus: r.bill_status,
    totalAmount: Number(r.total_amount),
    selfPay: Number(r.self_pay),
    insuranceCovered: Number(r.insurance_covered),
    copayment: Number(r.copayment),
    creditFlag: r.credit_flag,
  }))
}

export const getDeptSummary = async (startDate, endDate, patientType = null) => {
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : ""

  const result = await pool.query(`
    SELECT
      COALESCE(dept.department, 'ไม่ระบุแผนก') AS department,
      sub.item_type,
      COUNT(DISTINCT sub."HN" || '-' || sub."VN"::text || '-' || sub."VNSlash"::text) AS visit_count,
      COALESCE(SUM(sub.subtotal), 0) AS gross_revenue,
      COALESCE(SUM(sub.discount_amount), 0) AS total_discount,
      COALESCE(SUM(sub.line_total), 0) AS net_revenue,
      COALESCE(SUM(sub.insurance_covered_amount), 0) AS insurance_covered,
      COALESCE(SUM(sub.patient_responsibility_amount), 0) AS self_pay
    FROM (
      SELECT
        pp."HN",
        vp."VN",
        c."VNSlash",
        c.id AS case_id,
        li.subtotal,
        li.discount_amount,
        li.line_total,
        li.insurance_covered_amount,
        li.patient_responsibility_amount,
        CASE
          WHEN li.source_prescription_detail_id IS NOT NULL THEN 'ยา/เวชภัณฑ์'
          WHEN li.source_lab_order_item_id IS NOT NULL THEN 'Lab'
          WHEN li.source_radiology_order_item_id IS NOT NULL THEN 'Radiology'
          WHEN li.source_procedure_order_item_id IS NOT NULL THEN 'หัตถการ'
          WHEN li.source_operation_order_item_id IS NOT NULL THEN 'ผ่าตัด'
          WHEN li.source_rehab_order_item_id IS NOT NULL THEN 'Rehab'
          WHEN li.source_doctor_fee_id IS NOT NULL THEN 'ค่าแพทย์'
          WHEN li.source_medical_supply_order_detail_id IS NOT NULL THEN 'เวชภัณฑ์'
          ELSE 'อื่นๆ'
        END AS item_type
      FROM medrec_visitingpatient vp
      JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
      JOIN patient_patient pp ON pp.id = mr."HN_id"
      JOIN medrec_case c ON c."MRN_id"::text = vp."MRN_id"::text
      JOIN finance_medbill mb ON mb.case_id_id = c.id
      JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
      WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND mb.bill_status = 'FINALIZED'
        ${ptFilter}
    ) sub
    LEFT JOIN (
      SELECT DISTINCT ON (c.id)
        c.id AS case_id,
        d.name AS department
      FROM medrec_case c
      JOIN medrec_treatment t ON t.case_id = c.id
      JOIN hospital_department d ON d.id = t.department_id
      ORDER BY c.id, d.name
    ) dept ON dept.case_id = sub.case_id
    GROUP BY dept.department, sub.item_type
    ORDER BY dept.department, net_revenue DESC
  `, [startDate, endDate])

  return result.rows.map(r => ({
    department: r.department,
    itemType: r.item_type,
    visitCount: Number(r.visit_count),
    grossRevenue: Number(r.gross_revenue),
    totalDiscount: Number(r.total_discount),
    netRevenue: Number(r.net_revenue),
    insuranceCovered: Number(r.insurance_covered),
    selfPay: Number(r.self_pay),
  }))
}

export const getItemDetail = async (startDate, endDate, patientType = null) => {
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : ""

  const summaryResult = await pool.query(`
    SELECT
      COALESCE(dept.department, 'ไม่ระบุแผนก') AS department,
      sub.item_type,
      COUNT(DISTINCT sub."HN" || '-' || sub."VN" :: text || '-' || sub."VNSlash" :: text) AS visit_count,
      COALESCE(SUM(sub.subtotal), 0) AS gross_revenue,
      COALESCE(SUM(sub.discount_amount), 0) AS total_discount,
      COALESCE(SUM(sub.line_total), 0) AS net_revenue,
      COALESCE(SUM(sub.insurance_covered_amount), 0) AS insurance_covered,
      COALESCE(SUM(sub.patient_responsibility_amount), 0) AS self_pay
    FROM (
      SELECT
        pp."HN", vp."VN", c."VNSlash", c.id AS case_id,
        li.subtotal, li.discount_amount, li.line_total,
        li.insurance_covered_amount, li.patient_responsibility_amount,
        CASE
          WHEN li.source_prescription_detail_id IS NOT NULL THEN 'ยา/เวชภัณฑ์'
          WHEN li.source_lab_order_item_id IS NOT NULL THEN 'Lab'
          WHEN li.source_radiology_order_item_id IS NOT NULL THEN 'หัตถการ'
          WHEN li.source_procedure_order_item_id IS NOT NULL THEN 'ผ่าตัด'
          WHEN li.source_rehab_order_item_id IS NOT NULL THEN 'Rehab'
          WHEN li.source_doctor_fee_id IS NOT NULL THEN 'ค่าแพทย์'
          WHEN li.source_medical_supply_order_detail_id IS NOT NULL THEN 'เวชภัณฑ์'
          ELSE 'อื่นๆ'
        END AS item_type
      FROM medical_visitpatient vp
      JOIN medrec_medicalrecord mr ON mr."MRN" :: text = vp."MRN_id" :: text
      JOIN patient_patient pp ON pp.id = mr."HN_id"
      JOIN medrec_case c ON c."MRN_id" :: text = vp."MRN_id" :: text
      JOIN finance_medbill mb ON mb.case_id_id = c.id
      JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
      WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND mb.bill_status = 'FINALIZED'
        ${ptFilter}
    ) sub
    LEFT JOIN(
      SELECT DISTINCT ON (c.id) c.id AS case_id, d.name AS department
      FROM medrec_case c
      JOIN medrec_treatment t ON t.case_id = c.id
      JOIN hospital_department d ON d.id = t.department_id
      ORDER BY c.id, d.name
    ) dept ON dept.case_id = sub.case_id
    GROUP BY dept.department, sub.item_type
    ORDER BY dept.department, net_revenue DESC
    `, [startDate, endDate])

    const visitResult = await pool.query(`
      SELECT
        pp."HN",
        pp.firstname || ' ' || pp.surname AS patient_name,
        vp."VN",
        c."VNSlash",
        DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS visit_date,
        COALESCE(dept.department, 'ไม่ระบุแผนก') AS department,
        mb.total_amount AS bill_total,
        CASE
          WHEN li.source_prescription_detail_id IS NOT NULL THEN REPLACE(li.service_description, 'Drug: ', '')
          WHEN li.source_medical_supply_order_detail_id IS NOT NULL THEN REPLACE(li.service_description, 'Medical Supply: ', '')
          WHEN li.source_lab_order_item_id IS NOT NULL THEN REPLACE(li.service_description, 'Lab Test: ', '')
          WHEN li.source_reheb_order_item_id IS NOT NULL THEN REPLACE(li.service_description, 'Rehab Service: ', '')
          WHEN li.source_radiology_order_item_id IS NOT NULL THEN REPLACE(li.service_description, 'Radiology: ', '')
          WHEN li.source_procedure_order_item_id IS NOT NULL THEN REPLACE(li.service_description, 'Procedure: ', '')
          ELSE li.service_description
        END AS item_name,
        li.quantity, li.unit_price, li.subtotal,
        li.discount_amount, li.line_total,
        li.insurance_covered_amount, li.patient_responsibility_amount
      FROM medrec_visitingpatient vp
      JOIN medrec_medicalrecord mr ON mr."MRN" :: text = vp."MRN_id" :: text
      JOIN patient_patient pp ON pp.id = mr."HN_id"
      JOIN medrec_case c ON c."MRN_id" :: text = vp."MRN_id" :: text
      JOIN finance_medbill mb ON mb.case_id_id = c.id
      JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
      LEFT JOIN (
        SELECT DISTINCT ON (c.id) c.id AS case_id, d.name AS department
        FROM medrec_case c
        JOIN medrec_treatment t ON t.case_id = c.id
        JOIN hospital_department d ON d.id = t.department_id
        ORDER BY c.id, d.name
      ) dept ON dept.case_id = c.id
      WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND mb.bill_status = 'FIANLIZED'
        ${ptFilter}
      ORDER BY pp."HN", vp."VN", c."VNSlash", li.line_number
    `, [startDate, endDate])

    return {
      summary: summaryResult.rows.map(r => ({
        department: r.department,
        itemType: r.item_type,
        visitCount: Number(r.visit_count),
        grossRevenue: Number(r.gross_revenue),
        totalDiscount: Number(r.total_discount),
        netRevenue: Number(r.net_revenue),
        insuranceCovered: Number(r.insurance_covered ?? 0),
        selfPay: Number(r.self_pay),
      })),
      visits: visitResult.rows.map(r =>({
        hn: r.HN,
        patientName: r.patient_name,
        vn: r.VN,
        vnSlash: r.VNSlash,
        visitDate: r.visit_date,
        department: r.department,
        billTotal: Number(r.bill_total),
        itemType: r.item_type,
        quantity: Number(r.quantity ?? 1),
        unitPrice: Number(r.unit_price ?? 0),
        subtotal: Number(r.subtotal ?? 0),
        discountAmount: Number(r.discount_amount ?? 0),
        lineTotal: Number(r.line_total ?? 0),
        insuranceCovered: Number(r.insurance_covered_amount ?? 0),
      })),
    }
}


  