#!/usr/bin/env node
/**
 * Convert accsteam_standard_formart.txt to steam_cis_export.txt format
 * 
 * Input format: ID|email|password|username|token
 * Output format: username----password----email----token
 */

const fs = require('fs');
const path = require('path');

/**
 * Convert from standard format to CIS export format.
 * 
 * @param {string} inputFile - Path to input file (accsteam_standard_formart.txt)
 * @param {string} outputFile - Path to output file (steam_cis_export.txt)
 */
function convertFile(inputFile, outputFile) {
    try {
        // Read input file
        const inputContent = fs.readFileSync(inputFile, 'utf-8');
        const lines = inputContent.split('\n');
        
        const outputLines = [];
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) { // Skip empty lines
                continue;
            }
            
            // Split by pipe separator
            const parts = trimmedLine.split('|');
            
            // Expected format: ID|email|password|username|token
            if (parts.length >= 5) {
                const email = parts[1];
                const password = parts[2];
                const username = parts[3];
                const pw_steam = parts[4];
                
                // Write in CIS export format: username----pw_steam----email----password
                const outputLine = `${username}----${pw_steam}----${email}----${password}`;
                outputLines.push(outputLine);
            } else {
                console.warn(`Warning: Skipping malformed line: ${trimmedLine}`);
            }
        }
        
        // Write output file
        fs.writeFileSync(outputFile, outputLines.join('\n') + '\n', 'utf-8');
        console.log(`Conversion complete! Output written to ${outputFile}`);
        
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// Main execution
if (require.main === module) {
    const inputFile = 'accsteam_standard_formart.txt';
    const outputFile = 'steam_cis_export.txt';
    
    convertFile(inputFile, outputFile);
}

module.exports = { convertFile };

