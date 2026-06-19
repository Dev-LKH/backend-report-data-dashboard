import pool from "../db.js";

// ─── Shared helpers ────────────────────────────────────────────────────────────

const ITEM_TYPE_CASE = `
  CASE
    WHEN li.source_prescription_detail_id       IS NOT NULL THEN 'ยา/เวชภัณฑ์'
    WHEN li.source_lab_order_item_id            IS NOT NULL THEN 'Lab'
    WHEN li.source_radiology_order_item_id      IS NOT NULL THEN 'Radiology'
    WHEN li.source_procedure_order_item_id      IS NOT NULL THEN 'หัตถการ'
    WHEN li.source_operation_order_item_id      IS NOT NULL THEN 'ผ่าตัด'
    WHEN li.source_rehab_order_item_id          IS NOT NULL THEN 'Rehab'
    WHEN li.source_doctor_fee_id                IS NOT NULL THEN 'ค่าแพทย์'
    WHEN li.source_medical_supply_order_detail_id IS NOT NULL THEN 'เวชภัณฑ์'
    ELSE 'อื่นๆ'
  END
`;

// dept subquery — picks one department per case (alphabetically first)
const DEPT_SUBQUERY = `
  LEFT JOIN (
    SELECT DISTINCT ON (c.id) c.id AS case_id, d.name AS department
    FROM medrec_case c
    JOIN medrec_treatment t  ON t.case_id  = c.id
    JOIN hospital_department d ON d.id     = t.department_id
    ORDER BY c.id, d.name
  ) dept ON dept.case_id = c.id
`;

const toDay = (val) =>
  typeof val === "string" ? val.slice(0, 10) : val.toISOString().slice(0, 10);

const toNum = (v, fallback = 0) => Number(v ?? fallback);

// ─── getPatients ───────────────────────────────────────────────────────────────

export const getPatients = async () => {
  const { rows } = await pool.query(`
    SELECT id, "HN", firstname, surname, "createdAt"
    FROM patient_patient
    ORDER BY id DESC
    LIMIT 20
  `);
  return rows.map((p) => ({
    id: p.id,
    hn: p.HN,
    name: `${p.firstname} ${p.surname}`,
    createdAt: p.createdAt,
  }));
};

// ─── getStats ──────────────────────────────────────────────────────────────────

export const getStats = async (startDate, endDate, patientType = null) => {
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : "";

  const [visitsResult, deptResult, paymentResult, billBreakdownResult] =
    await Promise.all([
      // 1. visits per day — ไม่ depend on bill ดึงทุก visit
      pool.query(
        `
        SELECT
          DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS day,
          COUNT(DISTINCT vp.id) AS "totalVisitors",
          COUNT(DISTINCT vp.id) FILTER (WHERE mr."patientType" = 'OPD') AS opd,
          COUNT(DISTINCT vp.id) FILTER (WHERE mr."patientType" = 'IPD') AS ipd
        FROM medrec_visitingpatient vp
        JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text
        JOIN medrec_case c           ON c."MRN_id"::text = vp."MRN_id"::text
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
        GROUP BY DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok')
        ORDER BY day DESC
      `,
        [startDate, endDate]
      ),

      // 2. revenue + visitors per day per department — FINALIZED เท่านั้น
      pool.query(
        `
        SELECT
          DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS day,
          d.name AS department,
          COUNT(DISTINCT vp.id) AS visitors,
          COALESCE(SUM(case_rev.revenue), 0)        AS revenue,
          COALESCE(SUM(case_rev.gross_amount), 0)   AS gross_amount,
          COALESCE(SUM(case_rev.total_discount), 0) AS total_discount
        FROM medrec_visitingpatient vp
        JOIN medrec_medicalrecord mr ON mr."MRN"::text  = vp."MRN_id"::text
        JOIN medrec_case c           ON c."MRN_id"::text = vp."MRN_id"::text
        JOIN hospital_department d   ON d.id = c.department_id
        LEFT JOIN (
          SELECT c2.id AS case_id,
            COALESCE(SUM(li.line_total), 0)      AS revenue,
            COALESCE(SUM(li.subtotal), 0)        AS gross_amount,
            COALESCE(SUM(li.discount_amount), 0) AS total_discount
          FROM medrec_case c2
          JOIN finance_medbill mb         ON mb.case_id_id = c2.id
            AND mb.bill_status = 'FINALIZED'
          JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
          GROUP BY c2.id
        ) case_rev ON case_rev.case_id = c.id
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
        GROUP BY DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok'), d.name
        ORDER BY day DESC
      `,
        [startDate, endDate]
      ),

      // 3. payment breakdown per day — FINALIZED เท่านั้น
      pool.query(
        `
        SELECT
          DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS day,
          COALESCE(SUM(li.subtotal), 0)                      AS gross_amount,
          COALESCE(SUM(li.discount_amount), 0)               AS total_discount,
          COALESCE(SUM(li.line_total), 0)                    AS net_amount,
          COALESCE(SUM(li.patient_responsibility_amount), 0) AS self,
          COALESCE(SUM(li.insurance_covered_amount), 0)      AS insurance,
          COALESCE(SUM(li.copayment_amount), 0)              AS copayment
        FROM medrec_visitingpatient vp
        JOIN medrec_medicalrecord mr    ON mr."MRN"::text   = vp."MRN_id"::text
        JOIN medrec_case c              ON c."MRN_id"::text  = vp."MRN_id"::text
        JOIN finance_medbill mb         ON mb.case_id_id     = c.id
          AND mb.bill_status = 'FINALIZED'
        JOIN finance_medbilllineitem li ON li.med_bill_id    = mb.id
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
        GROUP BY DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok')
        ORDER BY day DESC
      `,
        [startDate, endDate]
      ),

      // 4. bill breakdown by status × insurance (ต้องการทั้ง DRAFT+FINALIZED เพื่อแสดง billSummary)
      pool.query(
        `
        SELECT
          bill_status,
          CASE WHEN ins_total > 0 THEN 'มีประกัน' ELSE 'ไม่มีประกัน' END AS insurance_flag,
          COUNT(*)          AS bill_count,
          SUM(line_total)   AS total_revenue
        FROM (
          SELECT
            mb.id, mb.bill_status,
            COALESCE(SUM(li.insurance_covered_amount), 0) AS ins_total,
            COALESCE(SUM(li.line_total), 0)               AS line_total
          FROM medrec_visitingpatient vp
          JOIN medrec_medicalrecord mr     ON mr."MRN"::text   = vp."MRN_id"::text
          JOIN medrec_case c               ON c."MRN_id"::text  = vp."MRN_id"::text
          JOIN finance_medbill mb          ON mb.case_id_id     = c.id
          LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
          WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
          ${ptFilter}
          GROUP BY mb.id, mb.bill_status
        ) sub
        GROUP BY bill_status, insurance_flag
        ORDER BY bill_status, insurance_flag
      `,
        [startDate, endDate]
      ),
    ]);

  const days = visitsResult.rows.map((v) => {
    const day = toDay(v.day);
    const departments = deptResult.rows
      .filter((d) => toDay(d.day) === day)
      .map((d) => ({
        name:          d.department,
        visitors:      toNum(d.visitors),
        revenue:       toNum(d.revenue),
        grossAmount:   toNum(d.gross_amount),
        totalDiscount: toNum(d.total_discount),
      }));
    const payment = paymentResult.rows.find((p) => toDay(p.day) === day);
    return {
      day,
      label: new Date(day + "T12:00:00").toLocaleDateString("th-TH", {
        day: "numeric", month: "short", year: "numeric",
      }),
      totalVisitors: toNum(v.totalVisitors),
      opd: toNum(v.opd),
      ipd: toNum(v.ipd),
      totalRevenue: departments.reduce((s, d) => s + d.revenue, 0),
      paymentBreakdown: {
        self:        toNum(payment?.self),
        insurance:   toNum(payment?.insurance),
        copayment:   toNum(payment?.copayment),
        grossAmount: toNum(payment?.gross_amount),
        discount:    toNum(payment?.total_discount),
        netAmount:   toNum(payment?.net_amount),
        พรบ: 0,
      },
      departments,
    };
  });

  const billBreakdown = { finalizedInsurance: 0, finalizedSelf: 0, draftInsurance: 0, draftSelf: 0 };
  billBreakdownResult.rows.forEach((r) => {
    const v = toNum(r.total_revenue);
    if (r.bill_status === "FINALIZED" && r.insurance_flag === "มีประกัน")   billBreakdown.finalizedInsurance = v;
    if (r.bill_status === "FINALIZED" && r.insurance_flag === "ไม่มีประกัน") billBreakdown.finalizedSelf      = v;
    if (r.bill_status === "DRAFT"     && r.insurance_flag === "มีประกัน")   billBreakdown.draftInsurance     = v;
    if (r.bill_status === "DRAFT"     && r.insurance_flag === "ไม่มีประกัน") billBreakdown.draftSelf          = v;
  });

  const finalizedTotal = billBreakdown.finalizedInsurance + billBreakdown.finalizedSelf;
  const draftTotal     = billBreakdown.draftInsurance     + billBreakdown.draftSelf;
  const totalBill      = finalizedTotal + draftTotal;

  return {
    days,
    billBreakdown,
    billSummary: {
      finalizedTotal,
      draftTotal,
      totalBill,
      finalizedPct: totalBill > 0 ? Math.round((finalizedTotal / totalBill) * 100) : 0,
      draftPct:     totalBill > 0 ? Math.round((draftTotal     / totalBill) * 100) : 0,
    },
  };
};

// ─── getPatientsByDay ──────────────────────────────────────────────────────────

export const getPatientsByDay = async (date) => {
  const { rows } = await pool.query(
    `
    SELECT
      DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS day,
      vp.id AS visit_id,
      c."visitType",
      pp.firstname || ' ' || pp.surname AS name,
      pp."HN"
    FROM medrec_visitingpatient vp
    JOIN medrec_case c          ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN medrec_medicalrecord mr ON mr."MRN"::text   = vp."MRN_id"::text
    JOIN patient_patient pp     ON pp.id = mr."HN_id"
    WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') = $1
      AND pp."HN" NOT IN ('4206910', '4206902', '4206901')
    ORDER BY vp.id DESC
  `,
    [date]
  );
  return rows.map((r) => ({
    visitId:   r.visit_id,
    hn:        r.HN,
    name:      r.name,
    visitType: r.visitType,
    day:       r.day,
  }));
};

// ─── getPatientVisitDetails ────────────────────────────────────────────────────

export const getPatientVisitDetails = async (date) => {
  const { rows } = await pool.query(
    `
    SELECT
      pp."HN",
      pp.firstname || ' ' || pp.surname AS name,
      c."visitType",
      DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS visit_date,
      vp.id AS visit_id,
      li.service_description,
      li.service_location,
      li.quantity,
      li.unit_price,
      li.line_total
    FROM medrec_visitingpatient vp
    JOIN medrec_case c           ON c."MRN_id"::text  = vp."MRN_id"::text
    JOIN medrec_medicalrecord mr ON mr."MRN"::text    = vp."MRN_id"::text
    JOIN patient_patient pp      ON pp.id             = mr."HN_id"
    LEFT JOIN finance_medbill mb         ON mb.case_id_id  = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') = $1
      AND pp."HN" NOT IN ('4206910', '4206902', '4206901')
    ORDER BY pp."HN", li.line_total DESC
  `,
    [date]
  );

  const map = new Map();
  for (const row of rows) {
    const key = `${row.HN}-${row.visit_id}`;
    if (!map.has(key)) {
      map.set(key, { hn: row.HN, name: row.name, visitType: row.visitType, items: [], totalAmount: 0 });
    }
    if (row.service_description) {
      const entry = map.get(key);
      entry.items.push({
        description: row.service_description,
        location:    row.service_location,
        quantity:    toNum(row.quantity, 1),
        unitPrice:   toNum(row.unit_price),
        lineTotal:   toNum(row.line_total),
      });
      entry.totalAmount += toNum(row.line_total);
    }
  }
  return Array.from(map.values());
};

// ─── getDoctorStats ────────────────────────────────────────────────────────────

export const getDoctorStats = async (startDate, endDate) => {
  const { rows } = await pool.query(
    `
    SELECT
      u.id AS doctor_id,
      COALESCE(
        NULLIF(TRIM(COALESCE(u.title,'') || ' ' || COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
        'ไม่ระบุชื่อ'
      ) AS doctor_name,
      d.name AS department,
      COUNT(DISTINCT c.id)            AS total_patients,
      COALESCE(SUM(li.line_total), 0) AS total_revenue
    FROM mfauth_customuser u
    JOIN medrec_case c ON c."doctor_id" = u.id
    JOIN finance_medbill mb          ON mb.case_id_id    = c.id
      AND mb.bill_status = 'FINALIZED'
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
                                        AND li.provider_id_id = u.id
    LEFT JOIN hospital_department d      ON d.id = u.department_id
    WHERE DATE(c."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
      AND c."doctor_id" IS NOT NULL
    GROUP BY u.id, u.title, u.first_name, u.last_name, d.name
    ORDER BY total_revenue DESC
  `,
    [startDate, endDate]
  );
  return rows.map((r) => ({
    id:             toNum(r.doctor_id),
    doctor_name:    r.doctor_name,
    department:     r.department ?? "ไม่ระบุแผนก",
    total_patients: toNum(r.total_patients),
    total_revenue:  toNum(r.total_revenue),
  }));
};

// ─── getAnalytics ──────────────────────────────────────────────────────────────

export const getAnalytics = async (startDate, endDate, groupBy = "day", patientType = null) => {
  const dateTrunc = {
    week:    `DATE_TRUNC('week',    vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`,
    month:   `DATE_TRUNC('month',   vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`,
    quarter: `DATE_TRUNC('quarter', vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`,
    year:    `DATE_TRUNC('year',    vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`,
  }[groupBy] ?? `DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok')`;

  const ptJoin   = patientType ? `JOIN medrec_medicalrecord mr ON mr."MRN"::text = vp."MRN_id"::text` : "";
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : "";

  const [revenueResult, deptTypeResult, deptNameResult, paymentResult, doctorResult, billBreakdownResult, todayResult, totalResult] =
    await Promise.all([
      // 1. revenue per period — FINALIZED เท่านั้น
      pool.query(
        `
        SELECT
          ${dateTrunc} AS period,
          COUNT(DISTINCT vp.id)               AS total_patients,
          COALESCE(SUM(li.line_total), 0)     AS total_revenue,
          COALESCE(SUM(li.subtotal), 0)       AS gross_amount,
          COALESCE(SUM(li.discount_amount),0) AS total_discount
        FROM medrec_visitingpatient vp
        ${ptJoin}
        JOIN medrec_case c              ON c."MRN_id"::text = vp."MRN_id"::text
        JOIN finance_medbill mb         ON mb.case_id_id    = c.id
          AND mb.bill_status = 'FINALIZED'
        JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
        GROUP BY ${dateTrunc}
        ORDER BY period ASC
      `,
        [startDate, endDate]
      ),

      // 2. revenue + visitors by dept type — FINALIZED เท่านั้น
      pool.query(
        `
        SELECT
          d.type,
          COUNT(DISTINCT vp.id)               AS patient_count,
          COALESCE(SUM(li.line_total), 0)     AS total_revenue,
          COALESCE(SUM(li.subtotal), 0)       AS gross_amount,
          COALESCE(SUM(li.discount_amount),0) AS total_discount
        FROM medrec_visitingpatient vp
        ${ptJoin}
        JOIN medrec_case c              ON c."MRN_id"::text = vp."MRN_id"::text
        JOIN finance_medbill mb         ON mb.case_id_id    = c.id
          AND mb.bill_status = 'FINALIZED'
        JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
        LEFT JOIN (
          SELECT DISTINCT ON (case_id) case_id, department_id
          FROM medrec_treatment ORDER BY case_id, id
        ) t ON t.case_id = c.id
        JOIN hospital_department d ON d.id = t.department_id
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
        GROUP BY d.type
        ORDER BY total_revenue DESC
      `,
        [startDate, endDate]
      ),

      // 3. revenue + visitors by dept name — FINALIZED เท่านั้น
      pool.query(
        `
        SELECT
          d.name, d.type,
          COUNT(DISTINCT vp.id)               AS patient_count,
          COALESCE(SUM(li.line_total), 0)     AS revenue,
          COALESCE(SUM(li.subtotal), 0)       AS gross_amount,
          COALESCE(SUM(li.discount_amount),0) AS total_discount
        FROM medrec_visitingpatient vp
        ${ptJoin}
        JOIN medrec_case c              ON c."MRN_id"::text = vp."MRN_id"::text
        JOIN finance_medbill mb         ON mb.case_id_id    = c.id
          AND mb.bill_status = 'FINALIZED'
        JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
        LEFT JOIN (
          SELECT DISTINCT ON (case_id) case_id, department_id
          FROM medrec_treatment ORDER BY case_id, id
        ) t ON t.case_id = c.id
        JOIN hospital_department d ON d.id = t.department_id
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
        GROUP BY d.name, d.type
        ORDER BY revenue DESC
      `,
        [startDate, endDate]
      ),

      // 4. payment totals — FINALIZED เท่านั้น
      pool.query(
        `
        SELECT
          COALESCE(SUM(li.patient_responsibility_amount), 0) AS self,
          COALESCE(SUM(li.insurance_covered_amount), 0)      AS insurance,
          COALESCE(SUM(li.copayment_amount), 0)              AS copayment,
          COALESCE(SUM(li.subtotal), 0)                      AS gross_amount,
          COALESCE(SUM(li.discount_amount), 0)               AS total_discount,
          COALESCE(SUM(li.line_total), 0)                    AS net_amount
        FROM medrec_visitingpatient vp
        JOIN medrec_case c              ON c."MRN_id"::text = vp."MRN_id"::text
        ${ptJoin}
        JOIN finance_medbill mb         ON mb.case_id_id    = c.id
          AND mb.bill_status = 'FINALIZED'
        JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
      `,
        [startDate, endDate]
      ),

      // 5. doctor stats — FINALIZED เท่านั้น
      pool.query(
        `
        SELECT
          u.id,
          COALESCE(
            NULLIF(TRIM(COALESCE(u.title,'') || ' ' || COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
            'ไม่ระบุชื่อ'
          ) AS doctor_name,
          d.name AS department,
          COUNT(DISTINCT c.id)            AS total_patients,
          COALESCE(SUM(li.line_total), 0) AS total_revenue
        FROM mfauth_customuser u
        JOIN medrec_case c ON c."doctor_id" = u.id
        JOIN finance_medbill mb          ON mb.case_id_id    = c.id
          AND mb.bill_status = 'FINALIZED'
        LEFT JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
                                            AND li.provider_id_id = u.id
        LEFT JOIN hospital_department d      ON d.id = u.department_id
        WHERE DATE(c."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
          AND c."doctor_id" IS NOT NULL
        GROUP BY u.id, u.title, u.first_name, u.last_name, d.name
        ORDER BY total_revenue DESC
      `,
        [startDate, endDate]
      ),

      // 6. bill breakdown (ต้องการทั้ง DRAFT+FINALIZED เพื่อแสดง billSummary)
      pool.query(
        `
        SELECT
          bill_status,
          CASE WHEN ins_total > 0 THEN 'มีประกัน' ELSE 'ไม่มีประกัน' END AS insurance_flag,
          COUNT(*)        AS bill_count,
          SUM(line_total) AS total_revenue
        FROM (
          SELECT
            mb.id, mb.bill_status,
            COALESCE(SUM(li.insurance_covered_amount), 0) AS ins_total,
            COALESCE(SUM(li.line_total), 0)               AS line_total
          FROM medrec_visitingpatient vp
          JOIN medrec_medicalrecord mr     ON mr."MRN"::text   = vp."MRN_id"::text
          JOIN medrec_case c               ON c."MRN_id"::text  = vp."MRN_id"::text
          JOIN finance_medbill mb          ON mb.case_id_id     = c.id
          LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
          WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
          ${ptFilter}
          GROUP BY mb.id, mb.bill_status
        ) sub
        GROUP BY bill_status, insurance_flag
        ORDER BY bill_status, insurance_flag
      `,
        [startDate, endDate]
      ),

      // 7. today's patient count
      pool.query(`
        SELECT COUNT(DISTINCT vp.id) AS total_patients
        FROM medrec_visitingpatient vp
        WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') = CURRENT_DATE
      `),

      // 8. all-time patient count
      pool.query(`
        SELECT COUNT(DISTINCT vp.id) AS total_patients
        FROM medrec_visitingpatient vp
      `),
    ]);

  return {
    revenue: revenueResult.rows.map((r) => ({
      period:         r.period,
      label:          new Date(r.period).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }),
      total_patients: toNum(r.total_patients),
      total_revenue:  toNum(r.total_revenue),
      gross_amount:   toNum(r.gross_amount),
      total_discount: toNum(r.total_discount),
    })),
    deptType: deptTypeResult.rows.map((r) => ({
      type:          r.type,
      visitors:      toNum(r.patient_count),
      revenue:       toNum(r.total_revenue),
      grossAmount:   toNum(r.gross_amount),
      totalDiscount: toNum(r.total_discount),
    })),
    deptName: deptNameResult.rows.map((r) => ({
      name:          r.name,
      type:          r.type,
      visitors:      toNum(r.patient_count),
      revenue:       toNum(r.revenue),
      grossAmount:   toNum(r.gross_amount),
      totalDiscount: toNum(r.total_discount),
    })),
    payment: {
      self:           toNum(paymentResult.rows[0]?.self),
      insurance:      toNum(paymentResult.rows[0]?.insurance),
      copayment:      toNum(paymentResult.rows[0]?.copayment),
      grossAmount:    toNum(paymentResult.rows[0]?.gross_amount),
      totalDiscount:  toNum(paymentResult.rows[0]?.total_discount),
      netAmount:      toNum(paymentResult.rows[0]?.net_amount),
      todayPatients:  toNum(todayResult.rows[0]?.total_patients),
      totalPatients:  toNum(totalResult.rows[0]?.total_patients),
    },
    doctors: doctorResult.rows.map((r) => ({
      id:             toNum(r.id),
      doctor_name:    r.doctor_name,
      department:     r.department ?? "ไม่ระบุแผนก",
      total_patients: toNum(r.total_patients),
      total_revenue:  toNum(r.total_revenue),
    })),
  };
};

// ─── getVisitTimeline ──────────────────────────────────────────────────────────

export const getVisitTimeline = async (startDate, endDate) => {
  const { rows } = await pool.query(
    `
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
    JOIN medrec_case c           ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN medrec_medicalrecord mr ON mr."MRN"::text   = vp."MRN_id"::text
    JOIN patient_patient pp      ON pp.id            = mr."HN_id"
    LEFT JOIN mfauth_customuser u        ON u.id           = c."doctor_id"
    LEFT JOIN medrec_treatment t         ON t.case_id       = c.id
    LEFT JOIN hospital_department d      ON d.id            = t.department_id
    LEFT JOIN finance_medbill mb         ON mb.case_id_id   = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id  = mb.id
    WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
    GROUP BY vp.id, pp."HN", pp.firstname, pp.surname,
             vp."createdAt", c."visitType",
             u.title, u.first_name, u.last_name, d.name
    ORDER BY vp."createdAt" DESC
  `,
    [startDate, endDate]
  );
  return rows.map((r) => ({
    visitId:        toNum(r.visit_id),
    hn:             r.HN,
    name:           r.name,
    visit_datetime: r.visit_datetime,
    visit_date:     new Date(r.visit_datetime).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }),
    visit_time:     new Date(r.visit_datetime).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }),
    visitType:      r.visitType,
    doctor_name:    r.doctor_name,
    department:     r.department ?? "ไม่ระบุ",
    revenue:        toNum(r.revenue),
  }));
};

// ─── getFilterOptions ──────────────────────────────────────────────────────────

export const getFilterOptions = async () => {
  const [deptResult, doctorResult] = await Promise.all([
    pool.query(`
      SELECT DISTINCT d.name AS department
      FROM hospital_department d
      WHERE name IS NOT NULL
      ORDER BY name
    `),
    pool.query(`
      SELECT DISTINCT
        u.id,
        COALESCE(
          NULLIF(TRIM(COALESCE(u.title,'') || ' ' || COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''),
          'ไม่ระบุชื่อ'
        ) AS doctor_name
      FROM mfauth_customuser u
      ORDER BY doctor_name
    `),
  ]);
  return {
    departments: deptResult.rows.map((r) => r.name),
    doctors:     doctorResult.rows.map((r) => ({ id: toNum(r.id), name: r.doctor_name })),
  };
};

// ─── getOpdOutstanding ─────────────────────────────────────────────────────────

export const getOpdOutstanding = async () => {
  const { rows } = await pool.query(`
    SELECT
      pp."HN",
      pp.firstname || ' ' || pp.surname AS name,
      mr."MRN",
      mb.bill_status,
      mb.total_amount,
      COALESCE(SUM(li.patient_responsibility_amount), 0) AS self_pay,
      COALESCE(SUM(li.insurance_covered_amount), 0)      AS insurance_covered,
      COALESCE(SUM(li.copayment_amount), 0)              AS copayment,
      CASE WHEN SUM(li.insurance_covered_amount) > 0 THEN 'ใช้เครดิต' ELSE '-' END AS credit_flag
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr     ON mr."MRN"::text   = vp."MRN_id"::text
    JOIN patient_patient pp          ON pp.id            = mr."HN_id"
    JOIN medrec_case c               ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN finance_medbill mb          ON mb.case_id_id    = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    WHERE mr."patientType" = 'OPD'
      AND mb.bill_status   = 'DRAFT'
    GROUP BY pp."HN", pp.firstname, pp.surname, mr."MRN", mb.bill_status, mb.total_amount
    ORDER BY mb.total_amount DESC
  `);
  return rows.map((r) => ({
    hn:               r.HN,
    name:             r.name,
    mrn:              r.MRN,
    billStatus:       r.bill_status,
    totalAmount:      toNum(r.total_amount),
    selfPay:          toNum(r.self_pay),
    insuranceCovered: toNum(r.insurance_covered),
    copayment:        toNum(r.copayment),
    creditFlag:       r.credit_flag,
  }));
};

// ─── getDeptSummary ────────────────────────────────────────────────────────────

export const getDeptSummary = async (startDate, endDate, patientType = null) => {
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : "";
  const { rows } = await pool.query(
    `
    SELECT
      COALESCE(dept.department, 'ไม่ระบุแผนก') AS department,
      sub.item_type,
      COUNT(DISTINCT sub."HN" || '-' || sub."VN"::text || '-' || sub."VNSlash"::text) AS visit_count,
      COALESCE(SUM(sub.subtotal), 0)                      AS gross_revenue,
      COALESCE(SUM(sub.discount_amount), 0)               AS total_discount,
      COALESCE(SUM(sub.line_total), 0)                    AS net_revenue,
      COALESCE(SUM(sub.insurance_covered_amount), 0)      AS insurance_covered,
      COALESCE(SUM(sub.patient_responsibility_amount), 0) AS self_pay
    FROM (
      SELECT
        pp."HN", vp."VN", c."VNSlash", c.id AS case_id,
        li.subtotal, li.discount_amount, li.line_total,
        li.insurance_covered_amount, li.patient_responsibility_amount,
        ${ITEM_TYPE_CASE} AS item_type
      FROM medrec_visitingpatient vp
      JOIN medrec_medicalrecord mr    ON mr."MRN"::text   = vp."MRN_id"::text
      JOIN patient_patient pp         ON pp.id            = mr."HN_id"
      JOIN medrec_case c              ON c."MRN_id"::text = vp."MRN_id"::text
      JOIN finance_medbill mb         ON mb.case_id_id    = c.id
        AND mb.bill_status = 'FINALIZED'
      JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
      WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        ${ptFilter}
    ) sub
    LEFT JOIN (
      SELECT DISTINCT ON (c.id) c.id AS case_id, d.name AS department
      FROM medrec_case c
      JOIN medrec_treatment t    ON t.case_id = c.id
      JOIN hospital_department d ON d.id      = t.department_id
      ORDER BY c.id, d.name
    ) dept ON dept.case_id = sub.case_id
    GROUP BY dept.department, sub.item_type
    ORDER BY dept.department, net_revenue DESC
  `,
    [startDate, endDate]
  );
  return rows.map((r) => ({
    department:       r.department,
    itemType:         r.item_type,
    visitCount:       toNum(r.visit_count),
    grossRevenue:     toNum(r.gross_revenue),
    totalDiscount:    toNum(r.total_discount),
    netRevenue:       toNum(r.net_revenue),
    insuranceCovered: toNum(r.insurance_covered),
    selfPay:          toNum(r.self_pay),
  }));
};

// ─── getItemDetail ─────────────────────────────────────────────────────────────

export const getItemDetail = async (startDate, endDate, patientType = null) => {
  const ptFilter = patientType ? `AND mr."patientType" = '${patientType}'` : "";

  const lineItemsFrom = `
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr    ON mr."MRN"::text   = vp."MRN_id"::text
    JOIN patient_patient pp         ON pp.id            = mr."HN_id"
    JOIN medrec_case c              ON c."MRN_id"::text = vp."MRN_id"::text
    JOIN finance_medbill mb         ON mb.case_id_id    = c.id
      AND mb.bill_status = 'FINALIZED'
    JOIN finance_medbilllineitem li ON li.med_bill_id   = mb.id
    WHERE DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
      ${ptFilter}
  `;

  const [summaryResult, visitResult] = await Promise.all([
    pool.query(
      `
      SELECT
        COALESCE(dept.department, 'ไม่ระบุแผนก') AS department,
        sub.item_type,
        COUNT(DISTINCT sub."HN" || '-' || sub."VN"::text || '-' || sub."VNSlash"::text) AS visit_count,
        COALESCE(SUM(sub.subtotal), 0)                      AS gross_revenue,
        COALESCE(SUM(sub.discount_amount), 0)               AS total_discount,
        COALESCE(SUM(sub.line_total), 0)                    AS net_revenue,
        COALESCE(SUM(sub.insurance_covered_amount), 0)      AS insurance_covered,
        COALESCE(SUM(sub.patient_responsibility_amount), 0) AS self_pay
      FROM (
        SELECT
          pp."HN", vp."VN", c."VNSlash", c.id AS case_id,
          li.subtotal, li.discount_amount, li.line_total,
          li.insurance_covered_amount, li.patient_responsibility_amount,
          ${ITEM_TYPE_CASE} AS item_type
        ${lineItemsFrom}
      ) sub
      LEFT JOIN (
        SELECT DISTINCT ON (c.id) c.id AS case_id, d.name AS department
        FROM medrec_case c
        JOIN medrec_treatment t    ON t.case_id = c.id
        JOIN hospital_department d ON d.id      = t.department_id
        ORDER BY c.id, d.name
      ) dept ON dept.case_id = sub.case_id
      GROUP BY dept.department, sub.item_type
      ORDER BY dept.department, net_revenue DESC
    `,
      [startDate, endDate]
    ),

    pool.query(
      `
      SELECT
        pp."HN",
        pp.firstname || ' ' || pp.surname AS patient_name,
        vp."VN",
        c."VNSlash",
        DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') AS visit_date,
        COALESCE(dept.department, 'ไม่ระบุแผนก') AS department,
        mb.total_amount AS bill_total,
        CASE
          WHEN li.source_prescription_detail_id         IS NOT NULL THEN REPLACE(li.service_description, 'Drug: ', '')
          WHEN li.source_medical_supply_order_detail_id IS NOT NULL THEN REPLACE(li.service_description, 'Medical Supply: ', '')
          WHEN li.source_lab_order_item_id              IS NOT NULL THEN REPLACE(li.service_description, 'Lab Test: ', '')
          WHEN li.source_rehab_order_item_id            IS NOT NULL THEN REPLACE(li.service_description, 'Rehab Service: ', '')
          WHEN li.source_radiology_order_item_id        IS NOT NULL THEN REPLACE(li.service_description, 'Radiology: ', '')
          WHEN li.source_procedure_order_item_id        IS NOT NULL THEN REPLACE(li.service_description, 'Procedure: ', '')
          ELSE li.service_description
        END AS item_name,
        ${ITEM_TYPE_CASE} AS item_type,
        li.quantity, li.unit_price, li.subtotal,
        li.discount_amount, li.line_total,
        li.insurance_covered_amount, li.patient_responsibility_amount
      ${lineItemsFrom}
      LEFT JOIN (
        SELECT DISTINCT ON (c.id) c.id AS case_id, d.name AS department
        FROM medrec_case c
        JOIN medrec_treatment t    ON t.case_id = c.id
        JOIN hospital_department d ON d.id      = t.department_id
        ORDER BY c.id, d.name
      ) dept ON dept.case_id = c.id
      ORDER BY pp."HN", vp."VN", c."VNSlash", li.line_number
    `,
      [startDate, endDate]
    ),
  ]);

  return {
    summary: summaryResult.rows.map((r) => ({
      department:       r.department,
      itemType:         r.item_type,
      visitCount:       toNum(r.visit_count),
      grossRevenue:     toNum(r.gross_revenue),
      totalDiscount:    toNum(r.total_discount),
      netRevenue:       toNum(r.net_revenue),
      insuranceCovered: toNum(r.insurance_covered),
      selfPay:          toNum(r.self_pay),
    })),
    visits: visitResult.rows.map((r) => ({
      hn:               r.HN,
      patientName:      r.patient_name,
      vn:               r.VN,
      vnSlash:          r.VNSlash,
      visitDate:        r.visit_date,
      department:       r.department,
      billTotal:        toNum(r.bill_total),
      itemType:         r.item_type,
      itemName:         r.item_name,
      quantity:         toNum(r.quantity, 1),
      unitPrice:        toNum(r.unit_price),
      subtotal:         toNum(r.subtotal),
      discountAmount:   toNum(r.discount_amount),
      lineTotal:        toNum(r.line_total),
      insuranceCovered: toNum(r.insurance_covered_amount),
      selfPay:          toNum(r.patient_responsibility_amount),
    })),
  };
};

// ─── getCaseList ───────────────────────────────────────────────────────────────

export const getCaseList = async ({
  startDate,
  endDate,
  patientType = null,
  department  = null,
  doctor      = null,
  billStatus  = null,   // 'FINALIZED' | 'DRAFT' | null = ทั้งหมด
}) => {
  const conditions = [
    `DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2`,
  ];
  const params = [startDate, endDate];
  let idx = 3;

  if (patientType) { conditions.push(`mr."patientType" = $${idx++}`); params.push(patientType); }
  if (department)  { conditions.push(`d.name = $${idx++}`);           params.push(department);  }
  if (doctor)      { conditions.push(`u.id = $${idx++}`);             params.push(doctor);      }
  if (billStatus)  { conditions.push(`mb.bill_status = $${idx++}`);   params.push(billStatus);  }

  const WHERE = conditions.join(" AND ");

  // ── Query 1: summary รายเคส ──────────────────────────────────────────────────
  const { rows: caseRows } = await pool.query(
    `
    SELECT
      vp.id                                                          AS visit_id,
      pp."HN",
      pp.firstname || ' ' || pp.surname                             AS patient_name,
      mr."patientType"                                              AS patient_type,
      DATE(vp."createdAt" AT TIME ZONE 'Asia/Bangkok')              AS visit_date,
      TO_CHAR(vp."createdAt" AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS visit_time,
      COALESCE(d.name, 'ไม่ระบุแผนก')                               AS department,
      COALESCE(
        NULLIF(TRIM(
          COALESCE(u.title,'') || ' ' ||
          COALESCE(u.first_name,'') || ' ' ||
          COALESCE(u.last_name,'')
        ), ''),
        'ไม่ระบุแพทย์'
      )                                                              AS doctor_name,
      mb.id                                                          AS bill_id,
      mb.bill_status,
      COALESCE(SUM(li.subtotal), 0)                                 AS gross_amount,
      COALESCE(SUM(li.discount_amount), 0)                          AS total_discount,
      COALESCE(SUM(li.line_total), 0)                               AS net_amount,
      COALESCE(SUM(li.insurance_covered_amount), 0)                 AS insurance_covered,
      COALESCE(SUM(li.patient_responsibility_amount), 0)            AS self_pay
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr     ON mr."MRN"::text    = vp."MRN_id"::text
    JOIN patient_patient pp          ON pp.id             = mr."HN_id"
    JOIN medrec_case c               ON c."MRN_id"::text  = vp."MRN_id"::text
    JOIN finance_medbill mb          ON mb.case_id_id     = c.id
    LEFT JOIN finance_medbilllineitem li ON li.med_bill_id = mb.id
    LEFT JOIN (
      SELECT DISTINCT ON (case_id) case_id, department_id
      FROM medrec_treatment ORDER BY case_id, id
    ) t ON t.case_id = c.id
    LEFT JOIN hospital_department d  ON d.id  = t.department_id
    LEFT JOIN mfauth_customuser u    ON u.id  = c."doctor_id"
    WHERE ${WHERE}
    GROUP BY
      vp.id, pp."HN", pp.firstname, pp.surname, mr."patientType",
      vp."createdAt", d.name,
      u.title, u.first_name, u.last_name,
      mb.id, mb.bill_status
    ORDER BY vp."createdAt" DESC, mb.id
    `,
    params
  );

  // ── Query 2: รายการ item ทุก case ในช่วงเวลาเดียวกัน ────────────────────────
  const { rows: itemRows } = await pool.query(
    `
    SELECT
      mb.id AS bill_id,
      CASE
        WHEN li.source_prescription_detail_id         IS NOT NULL THEN REPLACE(li.service_description, 'Drug: ', '')
        WHEN li.source_medical_supply_order_detail_id IS NOT NULL THEN REPLACE(li.service_description, 'Medical Supply: ', '')
        WHEN li.source_lab_order_item_id              IS NOT NULL THEN REPLACE(li.service_description, 'Lab Test: ', '')
        WHEN li.source_rehab_order_item_id            IS NOT NULL THEN REPLACE(li.service_description, 'Rehab Service: ', '')
        WHEN li.source_radiology_order_item_id        IS NOT NULL THEN REPLACE(li.service_description, 'Radiology: ', '')
        WHEN li.source_procedure_order_item_id        IS NOT NULL THEN REPLACE(li.service_description, 'Procedure: ', '')
        ELSE li.service_description
      END                                             AS item_name,
      ${ITEM_TYPE_CASE}                               AS item_type,
      li.quantity,
      li.unit_price,
      li.subtotal,
      li.discount_amount,
      li.line_total,
      li.insurance_covered_amount,
      li.patient_responsibility_amount
    FROM medrec_visitingpatient vp
    JOIN medrec_medicalrecord mr     ON mr."MRN"::text    = vp."MRN_id"::text
    JOIN patient_patient pp          ON pp.id             = mr."HN_id"
    JOIN medrec_case c               ON c."MRN_id"::text  = vp."MRN_id"::text
    JOIN finance_medbill mb          ON mb.case_id_id     = c.id
    JOIN finance_medbilllineitem li  ON li.med_bill_id    = mb.id
    LEFT JOIN (
      SELECT DISTINCT ON (case_id) case_id, department_id
      FROM medrec_treatment ORDER BY case_id, id
    ) t ON t.case_id = c.id
    LEFT JOIN hospital_department d  ON d.id  = t.department_id
    LEFT JOIN mfauth_customuser u    ON u.id  = c."doctor_id"
    WHERE ${WHERE}
    ORDER BY mb.id, li.line_number
    `,
    params
  );

  // group items by bill_id
  const itemMap = new Map();
  for (const row of itemRows) {
    if (!itemMap.has(row.bill_id)) itemMap.set(row.bill_id, []);
    itemMap.get(row.bill_id).push({
      itemName:         row.item_name,
      itemType:         row.item_type,
      quantity:         toNum(row.quantity, 1),
      unitPrice:        toNum(row.unit_price),
      subtotal:         toNum(row.subtotal),
      discountAmount:   toNum(row.discount_amount),
      lineTotal:        toNum(row.line_total),
      insuranceCovered: toNum(row.insurance_covered_amount),
      selfPay:          toNum(row.patient_responsibility_amount),
    });
  }

  return caseRows.map((r) => ({
    visitId:          toNum(r.visit_id),
    hn:               r.HN,
    patientName:      r.patient_name,
    patientType:      r.patient_type,
    visitDate:        r.visit_date,
    visitTime:        r.visit_time,
    department:       r.department,
    doctorName:       r.doctor_name,
    billId:           toNum(r.bill_id),
    billStatus:       r.bill_status,
    grossAmount:      toNum(r.gross_amount),
    totalDiscount:    toNum(r.total_discount),
    netAmount:        toNum(r.net_amount),
    insuranceCovered: toNum(r.insurance_covered),
    selfPay:          toNum(r.self_pay),
    items:            itemMap.get(toNum(r.bill_id)) ?? [],
  }));
};