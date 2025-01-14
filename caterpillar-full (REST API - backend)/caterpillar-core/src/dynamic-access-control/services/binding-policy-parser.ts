import {
  print,
  TypeMessage,
  printSeparator,
} from "../../adapters/messages/console-log";
import * as fs from "fs";
import * as path from "path";
import * as ejs from "ejs";

import { BigNumber } from "bignumber.js";

import antlr4 = require("antlr4/index");

import { ANTLRInputStream, CommonTokenStream } from "antlr4ts";
import { binding_grammarLexer } from "../utils/antlr/binding_grammarLexer";
import { binding_grammarParser } from "../utils/antlr/binding_grammarParser";
import { BindingVisitor } from "../utils/structs/binding-policy-visitor";
import { Policy } from "../utils/structs/policy-info";

const policy2solEJS = fs.readFileSync(
  path.join(__dirname, "./../../../templates-ejs/dynamic-access-control") +
    "/policy2sol.ejs",
  "utf-8"
);

const procesRole2solEJS = fs.readFileSync(
  path.join(__dirname, "./../../../templates-ejs/dynamic-access-control") +
    "/procesRole2sol.ejs",
  "utf-8"
);

const procesRole2ArrsolEJS = fs.readFileSync(
  path.join(__dirname, "./../../../templates-ejs/dynamic-access-control") +
    "/processRole2solArray.ejs",
  "utf-8"
);

let policy2solTemplate = ejs.compile(policy2solEJS);
let procesRole2solTemplate = ejs.compile(procesRole2solEJS);
let procesRole2solArrTemplate = ejs.compile(procesRole2ArrsolEJS);

export let generatePolicy = (policyStr: string, policyName: string) => {
  return new Promise<Policy>((resolve, reject) => {
    try {
      /////////////////////////////////////////////
      ///      LEXER AND PAXER (ANTLR)         ///
      ////////////////////////////////////////////

      let inputStream = new ANTLRInputStream(policyStr);
      let lexer = new binding_grammarLexer(inputStream);

      let tokenStream = new CommonTokenStream(lexer);
      let parser = new binding_grammarParser(tokenStream);

      parser.buildParseTree = true;

      let tree = parser.binding_policy();

      let visitor = new BindingVisitor();

      visitor.visit(tree);

      let policy = visitor.policy;

      /////////////////////////////////////////////
      ///  CONSISTENCY AND SEMANTIC ANALYSIS   ///
      ////////////////////////////////////////////

      // (1) every role must appear as case creator or nominee in some statement.
      for (let [key, value] of policy.roleIndexMap) {
        let found = false;
        if (policy.caseCreator !== key) {
          for (let i = 0; i < policy.nominationStatements.length; i++) {
            if (policy.nominationStatements[i].nominee == key) {
              found = true;
              break;
            }
          }
          if (!found)
            throw (
              "Role [" +
              key +
              "] cannot be nominated. \n Check that every role in the policy must appear as nominee, or case creator."
            );
        }
      }

      // (2) In each statement the nominator and every role in the binding and endorsement constraints must be BOUND before the nominee

      // (2.1) Constructing the Nomination Net
      // pB will be the index of the role (policy.indexRoleMap[role]), in case of self pU will be policy.indexRoleMap[role] + countRoles

      let transitions = [];
      let marking = [];
      marking[policy.roleIndexMap.get(policy.caseCreator)] = 1;
      policy.nominationStatements.forEach((statement) => {
        let output = policy.roleIndexMap.get(statement.nominee);
        let input = [];
        let taken = [];
        taken[policy.roleIndexMap.get(statement.nominee)] = 1;
        let addArc = (rIndex) => {
          if (taken[rIndex] !== 1) {
            input.push(rIndex);
            taken[rIndex] = 1;
          }
        };
        let updateConstraint = (conjunctionSet) => {
          conjunctionSet.forEach((andSet) => {
            andSet.roles.forEach((role) => {
              addArc(policy.roleIndexMap.get(role));
            });
          });
        };
        if (
          statement.nominator === statement.nominee ||
          statement.nominee === "self"
        ) {
          addArc(
            policy.roleIndexMap.get(statement.nominator) + policy.roleCount
          );
          if (
            taken[
              policy.roleIndexMap.get(statement.nominator) + policy.roleCount
            ] !== 1
          )
            marking[
              policy.roleIndexMap.get(statement.nominator) + policy.roleCount
            ] = 1;
        } else addArc(policy.roleIndexMap.get(statement.nominator));
        if (statement.bindingConstraint !== undefined)
          updateConstraint(statement.bindingConstraint.conjunctionSets);
        if (statement.endorsementConstraint !== undefined)
          updateConstraint(statement.endorsementConstraint.conjunctionSets);
        transitions.push({ input: input, output: output });
      });

      // (2.2) Validating the precedences (no dead transitions in the nomination net)

      let firedTransitions = [];
      let firedCount = 0;
      let roleOrder = [];
      let level = 0;

      while (true) {
        let toFire = [];
        for (let i = 0; i < transitions.length; i++) {
          if (firedTransitions[i] !== 1) {
            let input = transitions[i].input;
            // Validating If enabled
            let enabled = true;
            for (let j = 0; j < input.length; j++)
              if (marking[input[j]] !== 1) {
                enabled = false;
                break;
              }
            if (enabled) toFire.push(i);
          }
        }
        // No new enabled transition
        if (toFire.length === 0) break;
        level++;
        // Firing new enabled transitions
        toFire.forEach((trIndex) => {
          marking[transitions[trIndex].output] = 1;
          firedTransitions[trIndex] = 1;
          firedCount++;
          roleOrder[transitions[trIndex].output] = level;
        });
        // Every transition already fired, no dead transition
        if (firedCount === transitions.length) break;
      }
      if (firedCount < transitions.length) {
        let invalid = "";
        for (let [key, value] of policy.roleIndexMap) {
          if (marking[value] !== 1) invalid += "[" + key + "] ";
        }
        throw "Roles " + invalid + "cannot be nominated";
      } else {
        print("Success: the policy is consistent", TypeMessage.success);
        print(" Role Precedence: ", TypeMessage.data);
        print(`   0: ${policy.caseCreator}`, TypeMessage.data);
        for (let i = 1; i <= level; i++) {
          let inLevel = "";
          for (let [key, value] of policy.roleIndexMap) {
            if (roleOrder[value] === i) inLevel += key + " ";
          }
          print(`   ${i}: ${inLevel}`, TypeMessage.data);
        }
        printSeparator();
      }

      /////////////////////////////////////////////
      ///     SMART CONTRACT GENERATION        ///
      ////////////////////////////////////////////

      // (1) BitSet Operations

      let bitArrayToInteger = (bitarray) => {
        if (bitarray.length > 0) {
          let result = "0b";
          for (let i = bitarray.length - 1; i >= 0; i--)
            result += bitarray[i] ? "1" : "0";
          return new BigNumber(result).toFixed();
        } else {
          return "0";
        }
      };

      let roleMask = (roleId) => {
        if (policy.roleIndexMap.has(roleId)) {
          let bitarray = [];
          bitarray[policy.roleIndexMap.get(roleId)] = 1;
          return bitArrayToInteger(bitarray);
        } else {
          return "0";
        }
      };

      let nominatorMask = (statementList, nominator) => {
        let bitarray = [];
        statementList.forEach((statement) => {
          if (statement.nominator === nominator) {
            bitarray[policy.roleIndexMap.get(statement.nominee)] = 1;
          }
        });
        return bitArrayToInteger(bitarray);
      };

      let disjunctionSetMask = (disjunctionSet) => {
        let maskArray = [];
        disjunctionSet.conjunctionSets.forEach((andSet) => {
          let bitarray = [];
          andSet.roles.forEach((role) => {
            bitarray[policy.roleIndexMap.get(role)] = 1;
          });
          maskArray.push(bitArrayToInteger(bitarray));
        });
        return maskArray;
      };

      let disjunctionSetJoinMask = (disjunctionSet) => {
        let bitarray = [];
        disjunctionSet.conjunctionSets.forEach((andSet) => {
          andSet.roles.forEach((role) => {
            bitarray[policy.roleIndexMap.get(role)] = 1;
          });
        });
        return bitArrayToInteger(bitarray);
      };

      let statementMask = (statement) => {
        let bitarray = [];
        bitarray[policy.roleIndexMap.get(statement.nominator)] = 1;
        bitarray[policy.roleIndexMap.get(statement.nominee)] = 1;
        return bitArrayToInteger(bitarray);
      };

      let endorsementRequiredMask = (statements) => {
        let maskArray = [];
        statements.forEach((statement) => {
          if (statement.endorsementConstraint !== undefined)
            maskArray.push(statementMask(statement));
        });
        return maskArray;
      };

      let codeGenerationInfo = {
        policyName: policyName,
        roleIndex: (roleId) => policy.roleIndexMap.get(roleId),
        creatorMask: roleMask(policy.caseCreator),
        statementMask: (statement) => statementMask(statement),
        nominationStatements: policy.nominationStatements,
        nominationMask: (nominator, statements) =>
          nominatorMask(statements, nominator),
        disjunctionSetJoinMask: (disjunctionSet) =>
          disjunctionSetJoinMask(disjunctionSet),
        disjunctionSetMask: (disjunctionSet) =>
          disjunctionSetMask(disjunctionSet),
        endorsementRequiredMask: (statements) =>
          endorsementRequiredMask(statements),
        releaseStatements: policy.releaseStatements,
      };

      policy.solidity = policy2solTemplate(codeGenerationInfo);
      resolve(policy);
    } catch (ex) {
      print(`ERROR: ${ex}`, TypeMessage.error);
      reject(new Policy());
    }
  });
};

export let generateRoleTaskContract = (
  roleTaskPairs: Array<any>,
  contractName: string,
  isArray: boolean
) => {
  return new Promise<string>((resolve, reject) => {
    try {
      /////////////////////////////////////////////
      ///     SMART CONTRACT GENERATION        ///
      ////////////////////////////////////////////
	  
	  console.log("inside generateRoleTaskContract...");
      
      let processData = new Map<string, Array<any>>();
      processData.set(contractName, roleTaskPairs);

      let sortedMaping: Map<string, Array<number>> = new Map();
      if (isArray) {
        for (let [key, indexes] of processData) {
          let maxTaskInd = 0;
          indexes.forEach((index) => {
            maxTaskInd =
              index.taskIndex > maxTaskInd ? index.taskIndex : maxTaskInd;
          });
          let sorted: Array<number> = new Array();
          for (let i = 0; i <= maxTaskInd; i++) {
            let toPush = 0;
            indexes.forEach((index) => {
              if (index.taskIndex === i) toPush = index.roleIndex;
            });
            sorted.push(toPush);
          }
          sortedMaping.set(key, sorted);
        }
      } else {
        sortedMaping = processData;
      }

      let codeGenerationInfo = {
        contractName: contractName,
        processData: sortedMaping,
      };
      let policySolidity = isArray
        ? procesRole2solArrTemplate(codeGenerationInfo)
        : procesRole2solTemplate(codeGenerationInfo);
      resolve(policySolidity);
    } catch (ex) {
      print(`ERROR: ${ex}`, TypeMessage.error);
      reject("Error on the contract creation");
    }
  });
};
