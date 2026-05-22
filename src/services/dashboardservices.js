//
import pool from "../db.js";

export const fetchDashboardData = async () => {
    const result = await pool.query(`
        SELECT * FROM dashboard_data
        `);
        return result.rows;
};