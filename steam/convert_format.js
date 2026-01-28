#!/usr/bin/env node
/**
 * Convert acc_steam_hotmail.txt to steam_cis_export.txt format
 * 
 * Input format:
 *   Username: <username>
 *   Password: <password>
 *   E-Mail: <email>
 *   E-Mail Password: <email_password>
 * 
 * Output format: username----password----email----token
 */

const fs = require('fs');
const path = require('path');

/**
 * Convert from acc_steam_hotmail.txt format to CIS export format.
 * 
 * @param {string} inputFile - Path to input file (acc_steam_hotmail.txt)
 * @param {string} outputFile - Path to output file (steam_cis_export.txt)
 */
function convertFile(inputFile, outputFile) {
    try {
        // Read input file
        const inputContent = fs.readFileSync(inputFile, 'utf-8');
        const lines = inputContent.split('\n');
        
        const outputLines = [];
        let currentEntry = {};
        
        function processEntry() {
            if (currentEntry.username && currentEntry.password && currentEntry.email && currentEntry.token !== undefined) {
                const outputLine = `${currentEntry.username}----${currentEntry.password}----${currentEntry.email}----${currentEntry.token}`;
                outputLines.push(outputLine);
                currentEntry = {}; // Reset for next entry
            }
        }
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            
            // Skip empty lines and comment lines (starting with --)
            if (!trimmedLine || trimmedLine.startsWith('--')) {
                processEntry();
                continue;
            }
            
            // Parse each line
            if (trimmedLine.startsWith('Username:')) {
                // If we encounter a new Username line, process the previous entry first
                processEntry();
                currentEntry.username = trimmedLine.replace(/^Username:\s*/, '').trim();
            } else if (trimmedLine.startsWith('Password:')) {
                currentEntry.password = trimmedLine.replace(/^Password:\s*/, '').trim();
            } else if (trimmedLine.startsWith('E-Mail:')) {
                currentEntry.email = trimmedLine.replace(/^E-Mail:\s*/, '').trim();
            } else if (trimmedLine.startsWith('E-Mail Password:')) {
                currentEntry.token = trimmedLine.replace(/^E-Mail Password:\s*/, '').trim();
            }
        }
        
        // Process the last entry if it exists
        processEntry();
        
        // Write output file
        fs.writeFileSync(outputFile, outputLines.join('\n') + '\n', 'utf-8');
        console.log(`Conversion complete! ${outputLines.length} entries converted. Output written to ${outputFile}`);
        
    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
}

// Main execution
if (require.main === module) {
    const inputFile = 'acc_steam_hotmail.txt';
    const outputFile = 'steam_cis_export.txt';
    
    convertFile(inputFile, outputFile);
}

module.exports = { convertFile };

