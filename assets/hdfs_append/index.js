'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const path = require('path');


function getClient(context, config, type) {
    const clientConfig = {};
    clientConfig.type = type;

    if (config && config.connection) {
        clientConfig.endpoint = config.connection ? config.connection : 'default';
        clientConfig.cached = config.connection_cache !== undefined
            ? config.connection_cache : true;
    } else {
        clientConfig.endpoint = 'default';
        clientConfig.cached = true;
    }

    return context.foundation.getConnection(clientConfig);
}

function newProcessor(context, opConfig) {
    const logger = context.apis.foundation.makeLogger({ module: 'hdfs_append' });
    // Client connection cannot be cached, an endpoint needs to be re-instantiated for a different
    // namenode_host
    opConfig.connection_cache = false;

    /* This is used to keep track of HDFS append errors caused by corrupted replicas. If an error
    /* occurs, a suffix will be added to the filename and incremented for each subsequent error. The
    /* slice retry in a normal production job should take long enough to prevent the TS worker from
    /* smashing the Namenode, but a timer mechanism will still need to be implemented in order to
    /* prevent this from happening with faster-moving jobs. During the slice retry, this processor
    /* will end up seeing the incremented filename in the `appendErrors` object and use the updated
    /* name instead
     */
    // TODO: implement the timing mechanism. Current assumption is that retry and new slice
    //       processing duration will keep the worker from toppling the Namenode
    const appendErrors = {};

    // Records the name of the offending file with a detected corrupt block in `appendErrors`
    function recordFileError(name) {
        let newFilename = '';
        if (!appendErrors.retry && !appendErrors[name]) {
            newFilename = `${name}.0`;
            appendErrors[name] = newFilename;
            // Ensures this block will not be executed again after the first error for a file
            appendErrors.retry = true;
        } else {
            // Get the original file name from the error message
            const originalFile = name
                .split('.')
                .reverse()
                .splice(1)
                .reverse()
                .join('.');
            // Get the last attempted file and increment the number
            const incNum = appendErrors[originalFile].split('.').reverse()[0] * 1 + 1;
            newFilename = `${originalFile}.${incNum}`;
            // Set the new target for the next slice attempt
            appendErrors[originalFile] = newFilename;
        }
        return newFilename;
    }

    // This just checks `appendErrors` for the file to determine if data needs to be redirected to
    // the new file
    function checkFileHistory(name) {
        // If the file has already had an error, update the filename for the next write
        // attempt
        if (appendErrors[name]) {
            const attemptNum = appendErrors[name].split('.').reverse()[0] * 1;
            // This stops the worker from creating too many new files
            if (attemptNum > opConfig.max_write_errors) {
                throw new Error(
                    `${name} has exceeded the maximum number of write attempts!`
                );
            }
            return appendErrors[name];
        }
        return name;
    }

    const clientService = getClient(context, opConfig, 'hdfs_ha');
    const hdfsClient = clientService.client;

    function prepareFile(filename, chunks) {
        // We need to make sure the file exists before we try to append to it.
        return hdfsClient.getFileStatusAsync(filename)
            .catch(() => hdfsClient.mkdirsAsync(path.dirname(filename))
                .then(() => hdfsClient.createAsync(filename, ''))
                .catch((err) => {
                    const errMsg = err.stack;
                    return Promise.reject(
                        `Error while attempting to create the file: ${filename} on hdfs, error: `
                        + `${errMsg}`
                    );
                }))
            .return(chunks)
            // We need to serialize the storage of chunks so we run with concurrency 1
            .map(chunk => hdfsClient.appendAsync(filename, chunk), { concurrency: 1 })
            .catch((err) => {
                const errMsg = err.stack ? err.stack : err;
                let sliceError = '';
                /* Detecting the hdfs append error caused by block relocation and updating the
                /* filename. The `AlreadyBeingCreatedException` error is caused by something else
                /* and needs to be investigated further before implementing a fix. The error caused
                /* by the block relocation manifests itself as a stacktrace pointing at the file in
                /* this check.
                 */
                if (errMsg.indexOf('remoteexception.js') > -1) {
                    const newFilename = recordFileError(filename);
                    sliceError = `Error sending data to file '${filename}' due to HDFS append `
                        + `error. Changing destination to '${newFilename}'. Error: ${errMsg}`;
                } else {
                    sliceError = `Error sending data to file: ${filename}, Error: ${errMsg}`;
                }
                if (opConfig.log_data_on_error === true) {
                    sliceError = `${sliceError} Data: ${JSON.stringify(chunks)}`;
                }
                return Promise.reject(sliceError);
            });
    }

    return (data) => {
        // Start by mapping data chunks to their respective files
        const map = {};
        data.forEach((record) => {
            // This skips any records that have non-existant data payloads to avoid empty appends
            if (record.data.length > 0) {
                const file = checkFileHistory(record.filename);
                if (!map[file]) map[file] = [];
                map[file].push(record.data);
            }
        });

        function sendFiles() {
            const stores = [];
            _.forOwn(map, (chunks, key) => {
                stores.push(prepareFile(key, chunks, logger));
            });

            // We can process all individual files in parallel.
            return Promise.all(stores)
                .catch((err) => {
                    const errMsg = err.stack ? err.stack : err;
                    logger.error(`Error while sending to hdfs, error: ${errMsg}`);
                    return Promise.reject(err);
                });
        }

        return sendFiles();
    };
}

function schema() {
    // Most important schema configs are in the connection configuration
    return {
        connection: {
            doc: 'Name of the HDFS connection to use.',
            default: 'default',
            format: 'optional_String'
        },
        log_data_on_error: {
            doc: 'Determines whether or not to include the data for the slice in error messages',
            default: false,
            format: Boolean
        },
        max_write_errors: {
            doc: 'Determines how many times a worker can create a new file after append errors '
                + 'before throwing an error on every slice attempt. Defaults to 100',
            default: 100,
            format: (val) => {
                if (isNaN(val)) {
                    throw new Error('size parameter for max_write_errors must be a number!');
                } else if (val <= 0) {
                    throw new Error('size parameter for max_write_errors must be greater than zero!');
                }
            }
        }
    };
}

module.exports = {
    newProcessor,
    schema
};
