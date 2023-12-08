import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import license from "rollup-plugin-license";
import git from "git-rev-sync";

const outro = `
export const __info__ = {
    date: '${new Date().toISOString()}',
    hash: '${git.short()}',
    url: 'https://github.com/odoo/sfu',
};
`;

export default {
    input: "./src/client.js",
    output: [
        {
            banner: "/* @odoo-module */",
            file: "./bundle/odoo_sfu.js",
            format: "es",
            outro,
        },
    ],
    plugins: [
        commonjs(),
        resolve({
            browser: true,
            preferBuiltins: false,
        }),
        license({
            thirdParty: {
                output: "./bundle/odoo_sfu.licenses.txt",
            },
        }),
    ],
};
