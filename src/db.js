import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
    user: "postgres",
    host: "10.10.80.10",
    database: "postgres",
    password: "postgres",
    port: 8053,
});

export default pool;