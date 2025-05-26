import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
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
    input: "./src/client.ts",
    output: [
        {
            banner: "/* @odoo-module */",
            file: "./bundle/odoo_sfu.js",
            format: "es",
            outro,
        },
    ],
    plugins: [
        typescript({
            tsconfig: "./tsconfig_bundle.json",
            declaration: false,
            declarationMap: false,
            sourceMap: false,
        }),
        resolve({
            browser: true,
            preferBuiltins: false,
        }),
        commonjs(),
        license({
            thirdParty: {
                output: "./bundle/odoo_sfu.licenses.txt",
            },
        }),
    ],
};
